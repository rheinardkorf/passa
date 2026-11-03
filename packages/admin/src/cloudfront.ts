// The AWS domain provider (M4 R118, R119): domains are names on distribution
// tenants of one CloudFront multi-tenant distribution. Each tenant has one ACM
// certificate, validated through DNS, listing all its names; that works for
// apex domains too, which CloudFront-managed certificates refuse (early check).
//
// Each call moves a domain one step and returns its state, so the admin
// function can store it between calls.
//   attach: certificate (request it; wait for its validation records and for
//   ACM to issue it) → attaching (create or update the tenant) → deploying
//   (wait for CloudFront) → live.
//   detach: a shared tenant gets a certificate without the domain, then the
//   update; a tenant's last domain disables and deletes the tenant → gone.
import { createHash, randomBytes } from 'node:crypto';
import { type ACMClient, DeleteCertificateCommand, DescribeCertificateCommand, RequestCertificateCommand } from '@aws-sdk/client-acm';
import {
  type CloudFrontClient, CreateDistributionTenantCommand, DeleteDistributionTenantCommand,
  GetConnectionGroupCommand, GetDistributionTenantCommand, ListDistributionTenantsCommand, UpdateDistributionTenantCommand,
} from '@aws-sdk/client-cloudfront';
import type { Attachment, DnsRecord, DomainProvider, TenantChoice } from '@passa/shared';

export type CloudFrontDomainsConfig = {
  distributionId: string;
  connectionGroupId: string;
  // Tenants Passa made are named <prefix>-<random>, such as passa-prod-3k9x2a.
  prefix: string;
  // ACM's default limit on names per certificate is 10; CloudFront allows 100.
  namesPerTenant: number;
};

const TAGS = [{ Key: 'project', Value: 'passa' }];

// What Passa reads of a tenant, from a list or a get (whose ETag comes apart).
type Tenant = {
  Id?: string | undefined;
  Name?: string | undefined;
  Domains?: { Domain?: string | undefined; Status?: string | undefined }[] | undefined;
  Customizations?: { Certificate?: { Arn?: string | undefined } | undefined } | undefined;
  ConnectionGroupId?: string | undefined;
  Enabled?: boolean | undefined;
  Status?: string | undefined;
  ETag?: string | undefined;
};

// The attachment with changes applied; an undefined value removes a field.
type Change = { [K in keyof Attachment]?: Attachment[K] | undefined };
function step(a: Attachment, change: Change): Attachment {
  return Object.fromEntries(Object.entries({ ...a, ...change }).filter(([, v]) => v !== undefined)) as Attachment;
}

const names = (t: Tenant) => (t.Domains ?? []).map((d) => d.Domain ?? '').filter(Boolean);
const certificateOf = (t: Tenant) => t.Customizations?.Certificate?.Arn;
const gone = (a: Attachment): Attachment => ({ domain: a.domain, step: 'gone', records: a.records });

export class CloudFrontDomains implements DomainProvider {
  readonly cf: CloudFrontClient;
  readonly acm: ACMClient;
  readonly config: CloudFrontDomainsConfig;
  #endpoint?: Promise<string>;

  constructor(cf: CloudFrontClient, acm: ACMClient, config: CloudFrontDomainsConfig) {
    this.cf = cf;
    this.acm = acm;
    this.config = config;
  }

  async attach(domain: string, options: { tenant: TenantChoice; apex: boolean }, from?: Attachment): Promise<Attachment> {
    const pointer = this.#pointer(domain, options.apex, await this.#routingEndpoint());
    const a: Attachment = from ?? { domain, step: 'certificate', records: [pointer] };
    switch (a.step) {
      case 'certificate': return this.#certificate(a, options.tenant, pointer);
      case 'attaching': return this.#attachTenant(a, pointer);
      case 'deploying': return this.#deploying(a);
      case 'live': return a;
      default: throw new Error(`${domain} is being detached (${a.step})`);
    }
  }

  async detach(from: Attachment): Promise<Attachment> {
    const a = step(from, { step: 'detaching' });
    const tenant = a.tenant ? await this.#tenant(a.tenant) : undefined;

    // A shared tenant's update: once deployed, its old certificate goes.
    if (a.phase === 'deploying') {
      if (tenant && tenant.Status !== 'Deployed') return a;
      if (a.previousCertificate) await this.#deleteCertificate(a.previousCertificate);
      return gone(a);
    }
    // The tenant's last domain: once disabled, the tenant and its certificate go.
    if (a.phase === 'disabled') {
      if (tenant && tenant.Status !== 'Deployed') return a;
      if (tenant) await this.cf.send(new DeleteDistributionTenantCommand({ Id: tenant.Id, IfMatch: tenant.ETag }));
      const cert = tenant ? certificateOf(tenant) : a.certificate;
      if (cert) await this.#deleteCertificate(cert);
      return gone(a);
    }
    // Never attached: only its own certificate request is left.
    if (!tenant || !names(tenant).includes(a.domain)) {
      if (a.certificate && !(tenant && certificateOf(tenant) === a.certificate)) await this.#deleteCertificate(a.certificate);
      return gone(a);
    }

    const remaining = names(tenant).filter((n) => n !== a.domain);
    if (!remaining.length) {
      await this.#update(tenant, { Enabled: false });
      return step(a, { phase: 'disabled', problem: undefined });
    }
    if (a.phase !== 'certificate') {
      const certificate = await this.#request(remaining);
      return step(a, { phase: 'certificate', names: remaining, previousCertificate: certificateOf(tenant), certificate, problem: undefined });
    }
    const cert = await this.#describe(a.certificate ?? '');
    if (cert.status !== 'ISSUED') return step(a, { problem: cert.problem });
    await this.#update(tenant, { Domains: remaining.map((Domain) => ({ Domain })), Customizations: { Certificate: { Arn: a.certificate } } });
    return step(a, { phase: 'deploying', problem: undefined });
  }

  async #certificate(a: Attachment, choice: TenantChoice, pointer: DnsRecord): Promise<Attachment> {
    let next = a;
    if (!a.certificate) {
      const tenants = await this.#tenants();
      const holder = tenants.find((t) => names(t).includes(a.domain));
      if (holder) return step(a, { problem: `${a.domain} is already on tenant ${holder.Name}` });
      const fill = choice === 'fill' ? tenants.find((t) => t.Enabled !== false && names(t).length < this.config.namesPerTenant) : undefined;
      const all = fill ? [...names(fill), a.domain] : [a.domain];
      next = step(a, { names: all, certificate: await this.#request(all), tenant: fill?.Id, previousCertificate: fill && certificateOf(fill) });
    }
    const cert = await this.#describe(next.certificate ?? '');
    const records = [pointer, ...cert.records];
    if (cert.status === 'ISSUED') return step(next, { records, step: 'attaching', problem: undefined });
    return step(next, { records, problem: cert.problem });
  }

  async #attachTenant(a: Attachment, pointer: DnsRecord): Promise<Attachment> {
    const Domains = (a.names ?? [a.domain]).map((Domain) => ({ Domain }));
    const Customizations = { Certificate: { Arn: a.certificate } };
    if (a.tenant) {
      const tenant = await this.#tenant(a.tenant);
      // Another domain joined since the certificate was requested: it wouldn't
      // cover that one, so request this domain's certificate again.
      if (!tenant || names(tenant).some((n) => !(a.names ?? []).includes(n))) {
        if (a.certificate) await this.#deleteCertificate(a.certificate);
        return { domain: a.domain, step: 'certificate', records: [pointer], problem: 'The tenant changed while this domain waited; requesting its certificate again.' };
      }
      await this.#update(tenant, { Domains, Customizations, Enabled: true });
      return step(a, { step: 'deploying', problem: undefined });
    }
    const made = await this.cf.send(new CreateDistributionTenantCommand({
      DistributionId: this.config.distributionId,
      Name: `${this.config.prefix}-${randomBytes(3).toString('hex')}`,
      Domains,
      ConnectionGroupId: this.config.connectionGroupId,
      Customizations,
      Enabled: true,
      Tags: { Items: TAGS },
    }));
    return step(a, { tenant: made.DistributionTenant?.Id, step: 'deploying', problem: undefined });
  }

  async #deploying(a: Attachment): Promise<Attachment> {
    const tenant = await this.#tenant(a.tenant ?? '');
    const status = tenant?.Domains?.find((d) => d.Domain === a.domain)?.Status;
    if (tenant?.Status !== 'Deployed' || status !== 'active') return a;
    if (a.previousCertificate) await this.#deleteCertificate(a.previousCertificate);
    return step(a, { step: 'live', previousCertificate: undefined, problem: undefined });
  }

  // A CNAME to the connection group's routing endpoint, or an alias at an apex.
  #pointer(domain: string, apex: boolean, endpoint: string): DnsRecord {
    return apex ? { name: domain, type: 'A', value: endpoint, alias: true, purpose: 'pointer' } : { name: domain, type: 'CNAME', value: endpoint, purpose: 'pointer' };
  }

  #routingEndpoint() {
    this.#endpoint ??= this.cf.send(new GetConnectionGroupCommand({ Identifier: this.config.connectionGroupId }))
      .then((r) => r.ConnectionGroup?.RoutingEndpoint ?? Promise.reject(new Error('The connection group has no routing endpoint')));
    return this.#endpoint;
  }

  // Passa's tenants on its distribution (named with the prefix).
  async #tenants(): Promise<Tenant[]> {
    const out: Tenant[] = [];
    let Marker: string | undefined;
    do {
      const page = await this.cf.send(new ListDistributionTenantsCommand({ AssociationFilter: { DistributionId: this.config.distributionId }, ...(Marker ? { Marker } : {}) }));
      out.push(...(page.DistributionTenantList ?? []).filter((t) => t.Name?.startsWith(`${this.config.prefix}-`)));
      Marker = page.NextMarker;
    } while (Marker);
    return out;
  }

  async #tenant(id: string): Promise<Tenant | undefined> {
    try {
      const r = await this.cf.send(new GetDistributionTenantCommand({ Identifier: id }));
      return r.DistributionTenant ? { ...r.DistributionTenant, ETag: r.ETag } : undefined;
    } catch (err) {
      if ((err as { name?: string }).name === 'EntityNotFound') return undefined;
      throw err;
    }
  }

  // Updates take the whole tenant, so unchanged fields are sent as they are.
  #update(tenant: Tenant, change: { Domains?: { Domain: string }[]; Customizations?: { Certificate: { Arn: string | undefined } }; Enabled?: boolean }) {
    return this.cf.send(new UpdateDistributionTenantCommand({
      Id: tenant.Id,
      IfMatch: tenant.ETag,
      DistributionId: this.config.distributionId,
      ConnectionGroupId: tenant.ConnectionGroupId ?? this.config.connectionGroupId,
      Domains: change.Domains ?? names(tenant).map((Domain) => ({ Domain })),
      Customizations: change.Customizations ?? (certificateOf(tenant) ? { Certificate: { Arn: certificateOf(tenant) } } : undefined),
      Enabled: change.Enabled ?? tenant.Enabled ?? true,
    }));
  }

  async #request(all: string[]): Promise<string> {
    const r = await this.acm.send(new RequestCertificateCommand({
      DomainName: all[0],
      SubjectAlternativeNames: all,
      ValidationMethod: 'DNS',
      // The same names asked for again within an hour get the same certificate.
      IdempotencyToken: createHash('sha256').update(all.join(',')).digest('hex').slice(0, 32),
      Tags: TAGS,
    }));
    if (!r.CertificateArn) throw new Error('ACM returned no certificate');
    return r.CertificateArn;
  }

  async #describe(arn: string): Promise<{ status: string; records: DnsRecord[]; problem?: string }> {
    const { Certificate: c } = await this.acm.send(new DescribeCertificateCommand({ CertificateArn: arn }));
    const records: DnsRecord[] = [];
    for (const o of c?.DomainValidationOptions ?? []) {
      const rr = o.ResourceRecord;
      if (rr?.Name && rr.Value && !records.some((r) => r.name === rr.Name)) records.push({ name: rr.Name, type: 'CNAME', value: rr.Value, purpose: 'validation' });
    }
    const status = c?.Status ?? 'PENDING_VALIDATION';
    const failed = ['FAILED', 'VALIDATION_TIMED_OUT', 'REVOKED'].includes(status);
    return {
      status, records,
      ...(failed ? { problem: `The certificate ${status.toLowerCase().replace(/_/g, ' ')}${c?.FailureReason ? ` (${c.FailureReason})` : ''}; remove the domain and add it again` } : {}),
    };
  }

  async #deleteCertificate(arn: string) {
    try {
      await this.acm.send(new DeleteCertificateCommand({ CertificateArn: arn }));
    } catch (err) {
      // Still in use (CloudFront lets go a little after an update) or already
      // gone: neither should stop the domain. A certificate left over costs nothing.
      if (!['ResourceInUseException', 'ResourceNotFoundException'].includes((err as { name?: string }).name ?? '')) throw err;
    }
  }
}
