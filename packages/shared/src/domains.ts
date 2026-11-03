// Custom domains (M4): what a domain record holds, which hostnames may be
// attached, and the two provider interfaces. A domain provider attaches a
// domain and its certificate (CloudFront SaaS Manager on AWS, Cloudflare when
// self-hosted); a DNS provider writes the records (Route 53, or a person).

// A DNS record a domain needs. pointer sends the domain to Passa; validation
// proves control of it for its certificate. alias: an apex can't have a CNAME,
// so its pointer is an alias A record (Route 53) or the host's ALIAS, ANAME or
// flattened CNAME.
export type DnsRecord = {
  name: string;
  type: 'CNAME' | 'A';
  value: string;
  purpose: 'pointer' | 'validation';
  alias?: boolean;
};

// Where an attach or detach has got to. The admin function stores it with the
// domain and calls the provider again until the domain is live (or gone).
export type DomainStep = 'certificate' | 'attaching' | 'deploying' | 'live' | 'detaching' | 'gone';

// What a provider tracks for one domain, between calls.
export type Attachment = {
  domain: string;
  step: DomainStep;
  records: DnsRecord[];
  tenant?: string;
  // Every name the certificate covers: the tenant's names, with this domain.
  names?: string[];
  certificate?: string;
  // Where a multi-call step has got to (a detach: certificate, deploying, disabled).
  phase?: string;
  // A certificate the tenant used before this change, deleted once it's live.
  previousCertificate?: string;
  // Why the domain is stuck, in words for the admin.
  problem?: string;
};

export type TenantChoice = 'fill' | 'new';

export interface DomainProvider {
  // Starts or continues attaching. apex: the domain is a zone apex, so its
  // pointer must be an alias. Returns the new state; call again until live.
  attach(domain: string, options: { tenant: TenantChoice; apex: boolean }, from?: Attachment): Promise<Attachment>;
  // Starts or continues detaching; returns step 'gone' when it's done.
  detach(from: Attachment): Promise<Attachment>;
}

export interface DnsProvider {
  readonly kind: 'route53' | 'manual';
  // The zone this provider manages for the domain, or undefined.
  zoneFor(domain: string): Promise<{ id: string; name: string } | undefined>;
  // Writes the records (a manual provider leaves that to a person).
  upsert(records: DnsRecord[]): Promise<void>;
  remove(records: DnsRecord[]): Promise<void>;
}

// A domain attached to a site: stored in the database, keyed by the domain.
export type Domain = Attachment & {
  siteId: string;
  role: 'primary' | 'alias';
  // Records Passa wrote itself, so remove takes away only those.
  wrote: DnsRecord[];
  createdAt: string;
  updatedAt: string;
};

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

// R114: a lowercase hostname of two or more labels, not under the site domain;
// under Passa's own domain it's allowed with a warning (same-site with auth.).
export function checkDomain(domain: string, deployment: { domain: string; siteDomain: string }): { problem?: string; warning?: string } {
  const labels = domain.split('.');
  if (domain !== domain.toLowerCase() || domain.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l)) || /^\d+$/.test(labels.at(-1) ?? '')) {
    return { problem: `${domain} isn't a valid domain name (lowercase letters, digits and hyphens, such as docs.example.com)` };
  }
  const under = (parent: string) => domain === parent || domain.endsWith(`.${parent}`);
  if (under(deployment.siteDomain)) return { problem: `${domain} is under the site domain (${deployment.siteDomain}), where sites already have addresses; use passa name instead` };
  if (under(deployment.domain)) {
    return { warning: `${domain} is under Passa's own domain (${deployment.domain}), so the site is same-site with auth.${deployment.domain}. Passa doesn't rely on that boundary, but a separate domain is safer.` };
  }
  return {};
}

// Cloudflare's published IPv4 ranges (cloudflare.com/ips). A domain resolving
// here is proxied by Cloudflare (orange cloud), so it isn't reaching CloudFront.
const CLOUDFLARE = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

const ipv4 = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);

export function behindCloudflare(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  return CLOUDFLARE.some((range) => {
    const [base = '', bits = '32'] = range.split('/');
    const size = 2 ** (32 - Number(bits));
    return Math.floor(ipv4(ip) / size) === Math.floor(ipv4(base) / size);
  });
}
