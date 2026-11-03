// Test doubles for the AWS services the providers use: CloudFront and ACM in
// memory, where certificates wait to be issued and tenants wait to deploy.
type Cert = { arn: string; names: string[]; status: string };
type Tenant = { Id: string; Name: string; Domains: { Domain: string; Status: string }[]; Customizations?: { Certificate: { Arn: string } }; Enabled: boolean; Status: string; ETag: string; ConnectionGroupId: string };

// CloudFront and ACM in memory: certificates wait to be issued, tenants wait
// to deploy, and updates need the current ETag, as the real services do.
export class FakeAws {
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
