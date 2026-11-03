import type { ACMClient } from '@aws-sdk/client-acm';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import type { Attachment } from '@passa/shared';
import { describe, expect, it } from 'vitest';
import { CloudFrontDomains } from './cloudfront.ts';

type Cert = { arn: string; names: string[]; status: string };
type Tenant = { Id: string; Name: string; Domains: { Domain: string; Status: string }[]; Customizations?: { Certificate: { Arn: string } }; Enabled: boolean; Status: string; ETag: string; ConnectionGroupId: string };

// CloudFront and ACM in memory: certificates wait to be issued, tenants wait
// to deploy, and updates need the current ETag, as the real services do.
class FakeAws {
  certs = new Map<string, Cert>();
  tenants = new Map<string, Tenant>();
  deleted: string[] = [];
  #n = 0;

  issue() {
    for (const c of this.certs.values()) if (c.status === 'PENDING_VALIDATION') c.status = 'ISSUED';
  }
  deploy() {
    for (const t of this.tenants.values()) {
      t.Status = 'Deployed';
      const covered = this.certs.get(t.Customizations?.Certificate.Arn ?? '')?.names ?? [];
      for (const d of t.Domains) d.Status = t.Enabled && covered.includes(d.Domain) ? 'active' : 'inactive';
    }
  }
  #etag(t: Tenant) {
    t.ETag = `E${++this.#n}`;
  }

  async send(command: { constructor: { name: string }; input: Record<string, never> }): Promise<unknown> {
    const i = command.input as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    switch (command.constructor.name) {
      case 'GetConnectionGroupCommand': return { ConnectionGroup: { RoutingEndpoint: 'd111.cloudfront.net' } };
      case 'RequestCertificateCommand': {
        const arn = `arn:cert:${++this.#n}`;
        this.certs.set(arn, { arn, names: i.SubjectAlternativeNames, status: 'PENDING_VALIDATION' });
        return { CertificateArn: arn };
      }
      case 'DescribeCertificateCommand': {
        const c = this.certs.get(i.CertificateArn);
        return { Certificate: { Status: c?.status, DomainValidationOptions: c?.names.map((n) => ({ ResourceRecord: { Name: `_v.${n}.`, Value: `_t.acm-validations.aws.`, Type: 'CNAME' } })) } };
      }
      case 'DeleteCertificateCommand': {
        if ([...this.tenants.values()].some((t) => t.Customizations?.Certificate.Arn === i.CertificateArn)) throw Object.assign(new Error('in use'), { name: 'ResourceInUseException' });
        this.certs.delete(i.CertificateArn);
        this.deleted.push(i.CertificateArn);
        return {};
      }
      case 'ListDistributionTenantsCommand': return { DistributionTenantList: [...this.tenants.values()].map((t) => ({ ...t })) };
      case 'GetDistributionTenantCommand': {
        const t = this.tenants.get(i.Identifier);
        if (!t) throw Object.assign(new Error('no tenant'), { name: 'EntityNotFound' });
        const { ETag, ...rest } = t;
        return { DistributionTenant: structuredClone(rest), ETag };
      }
      case 'CreateDistributionTenantCommand': {
        const t: Tenant = { Id: `dt_${++this.#n}`, Name: i.Name, Domains: i.Domains.map((d: { Domain: string }) => ({ Domain: d.Domain, Status: 'inactive' })), Customizations: i.Customizations, Enabled: i.Enabled, Status: 'InProgress', ETag: '', ConnectionGroupId: i.ConnectionGroupId };
        this.#etag(t);
        this.tenants.set(t.Id, t);
        return { DistributionTenant: { Id: t.Id } };
      }
      case 'UpdateDistributionTenantCommand': {
        const t = this.tenants.get(i.Id);
        if (!t || t.ETag !== i.IfMatch) throw Object.assign(new Error('precondition failed'), { name: 'PreconditionFailed' });
        // CloudFront checks the certificate covers every name (ownership).
        const covered = this.certs.get(i.Customizations?.Certificate?.Arn ?? '')?.names ?? [];
        if (i.Domains.some((d: { Domain: string }) => !covered.includes(d.Domain))) throw Object.assign(new Error('Could not verify Domain Name ownership'), { name: 'InvalidArgument' });
        t.Domains = i.Domains.map((d: { Domain: string }) => ({ Domain: d.Domain, Status: t.Domains.find((o) => o.Domain === d.Domain)?.Status ?? 'inactive' }));
        t.Customizations = i.Customizations;
        t.Enabled = i.Enabled;
        t.Status = 'InProgress';
        this.#etag(t);
        return {};
      }
      case 'DeleteDistributionTenantCommand': {
        const t = this.tenants.get(i.Id);
        if (!t || t.ETag !== i.IfMatch || t.Enabled) throw Object.assign(new Error('cannot delete'), { name: 'PreconditionFailed' });
        this.tenants.delete(i.Id);
        return {};
      }
    }
    throw new Error(`fake: ${command.constructor.name}`);
  }
}

const setup = (namesPerTenant = 10) => {
  const aws = new FakeAws();
  const provider = new CloudFrontDomains(aws as unknown as CloudFrontClient, aws as unknown as ACMClient, { distributionId: 'EDIST', connectionGroupId: 'cg_1', prefix: 'passa-test', namesPerTenant });
  return { aws, provider };
};

// Drives an attach to live, issuing and deploying whenever it waits.
async function attachToLive(provider: CloudFrontDomains, aws: FakeAws, domain: string, tenant: 'fill' | 'new', apex = false) {
  let a: Attachment | undefined;
  for (let i = 0; i < 8; i++) {
    a = await provider.attach(domain, { tenant, apex }, a);
    if (a.step === 'live') return a;
    if (a.step === 'certificate') aws.issue();
    if (a.step === 'deploying') aws.deploy();
  }
  throw new Error(`${domain} didn't go live: ${JSON.stringify(a)}`);
}

async function detachToGone(provider: CloudFrontDomains, aws: FakeAws, from: Attachment) {
  let a = from;
  for (let i = 0; i < 8; i++) {
    a = await provider.detach(a);
    if (a.step === 'gone') return a;
    aws.issue();
    aws.deploy();
  }
  throw new Error(`${from.domain} wasn't detached: ${JSON.stringify(a)}`);
}

describe('attaching a domain (R118)', () => {
  it('asks for the pointer and the certificate validation records, then attaches once it is issued', async () => {
    const { aws, provider } = setup();
    const first = await provider.attach('docs.example.com', { tenant: 'new', apex: false });
    expect(first.step).toBe('certificate');
    expect(first.records).toEqual([
      { name: 'docs.example.com', type: 'CNAME', value: 'd111.cloudfront.net', purpose: 'pointer' },
      { name: '_v.docs.example.com.', type: 'CNAME', value: '_t.acm-validations.aws.', purpose: 'validation' },
    ]);
    // Not issued yet: it waits, and asks for the same records.
    expect((await provider.attach('docs.example.com', { tenant: 'new', apex: false }, first)).step).toBe('certificate');
    aws.issue();
    const attaching = await provider.attach('docs.example.com', { tenant: 'new', apex: false }, first);
    expect(attaching.step).toBe('attaching');
    const deploying = await provider.attach('docs.example.com', { tenant: 'new', apex: false }, attaching);
    expect(deploying.step).toBe('deploying');
    const tenant = [...aws.tenants.values()][0];
    expect(tenant?.Name).toMatch(/^passa-test-[0-9a-f]{6}$/);
    expect(tenant?.Customizations?.Certificate.Arn).toBe(first.certificate);
    expect((await provider.attach('docs.example.com', { tenant: 'new', apex: false }, deploying)).step).toBe('deploying');
    aws.deploy();
    expect((await provider.attach('docs.example.com', { tenant: 'new', apex: false }, deploying)).step).toBe('live');
  });

  it('points an apex with an alias record', async () => {
    const { provider } = setup();
    const a = await provider.attach('example.com', { tenant: 'new', apex: true });
    expect(a.records[0]).toEqual({ name: 'example.com', type: 'A', value: 'd111.cloudfront.net', alias: true, purpose: 'pointer' });
  });

  it('refuses a domain already on a tenant', async () => {
    const { aws, provider } = setup();
    await attachToLive(provider, aws, 'docs.example.com', 'new');
    expect((await provider.attach('docs.example.com', { tenant: 'fill', apex: false })).problem).toMatch(/already on tenant passa-test-/);
  });
});

describe('choosing a tenant (R119)', () => {
  it('--fill-tenant joins a tenant with room, with a new certificate for both, and deletes the old one', async () => {
    const { aws, provider } = setup();
    const first = await attachToLive(provider, aws, 'a.example.com', 'new');
    const second = await attachToLive(provider, aws, 'b.example.com', 'fill');
    expect(aws.tenants.size).toBe(1);
    const tenant = [...aws.tenants.values()][0];
    expect(tenant?.Domains.map((d) => d.Domain)).toEqual(['a.example.com', 'b.example.com']);
    expect(aws.certs.get(second.certificate ?? '')?.names).toEqual(['a.example.com', 'b.example.com']);
    expect(aws.deleted).toEqual([first.certificate]);
  });

  it('--fill-tenant starts a tenant when none has room, and --new-tenant always does', async () => {
    const { aws, provider } = setup(1);
    await attachToLive(provider, aws, 'a.example.com', 'fill');
    await attachToLive(provider, aws, 'b.example.com', 'fill');
    expect(aws.tenants.size).toBe(2);
    const roomy = setup(10);
    await attachToLive(roomy.provider, roomy.aws, 'a.example.com', 'new');
    await attachToLive(roomy.provider, roomy.aws, 'b.example.com', 'new');
    expect(roomy.aws.tenants.size).toBe(2);
  });

  it('requests the certificate again if the tenant changed while it waited', async () => {
    const { aws, provider } = setup();
    await attachToLive(provider, aws, 'a.example.com', 'new');
    let b = await provider.attach('b.example.com', { tenant: 'fill', apex: false });
    // c joins the same tenant before b's certificate is issued.
    await attachToLive(provider, aws, 'c.example.com', 'fill');
    aws.issue();
    b = await provider.attach('b.example.com', { tenant: 'fill', apex: false }, b);
    b = await provider.attach('b.example.com', { tenant: 'fill', apex: false }, b);
    expect(b).toMatchObject({ step: 'certificate', problem: expect.stringMatching(/tenant changed/) });
    const live = await attachToLive(provider, aws, 'b.example.com', 'fill');
    expect(aws.certs.get(live.certificate ?? '')?.names).toEqual(['a.example.com', 'c.example.com', 'b.example.com']);
  });
});

describe('detaching a domain (R117)', () => {
  it('takes a domain off a shared tenant with a certificate for the rest', async () => {
    const { aws, provider } = setup();
    await attachToLive(provider, aws, 'a.example.com', 'new');
    const b = await attachToLive(provider, aws, 'b.example.com', 'fill');
    await detachToGone(provider, aws, b);
    const tenant = [...aws.tenants.values()][0];
    expect(tenant?.Domains.map((d) => d.Domain)).toEqual(['a.example.com']);
    expect(aws.certs.get(tenant?.Customizations?.Certificate.Arn ?? '')?.names).toEqual(['a.example.com']);
    expect(aws.deleted).toContain(b.certificate);
  });

  it('deletes a tenant, and its certificate, with its last domain', async () => {
    const { aws, provider } = setup();
    const a = await attachToLive(provider, aws, 'a.example.com', 'new');
    await detachToGone(provider, aws, a);
    expect(aws.tenants.size).toBe(0);
    expect(aws.certs.size).toBe(0);
  });

  it('cleans up a domain that never got past its certificate', async () => {
    const { aws, provider } = setup();
    const a = await provider.attach('a.example.com', { tenant: 'new', apex: false });
    expect((await provider.detach(a)).step).toBe('gone');
    expect(aws.certs.size).toBe(0);
  });
});
