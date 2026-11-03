import { describe, expect, it } from 'vitest';
import { addDomain, type DnsRecord, type DomainReport, formatList, formatStatus, type Invoke, removeDomain } from './admin.ts';

const pointer: DnsRecord = { name: 'docs.example.com', type: 'CNAME', value: 'd111.cloudfront.net', purpose: 'pointer' };
const validation: DnsRecord = { name: '_v.docs.example.com.', type: 'CNAME', value: '_t.acm-validations.aws.', purpose: 'validation' };
const report = (over: Partial<DomainReport>): DomainReport => ({ domain: 'docs.example.com', site: 'docs', role: 'primary', step: 'certificate', dns: 'route53', records: [pointer, validation], waiting: [], ...over });

// An admin function that answers each call with the next report.
function scripted(...reports: DomainReport[]) {
  const calls: Record<string, unknown>[] = [];
  const invoke: Invoke = async (payload) => {
    calls.push(payload);
    return reports[Math.min(calls.length - 1, reports.length - 1)];
  };
  return { invoke, calls };
}

const run = async (fn: (p: { out: (l: string) => void; wait: () => Promise<void> }) => Promise<unknown>) => {
  const lines: string[] = [];
  await fn({ out: (l) => lines.push(l), wait: async () => undefined });
  return lines;
};

describe('passa admin domain add', () => {
  it('shows the records Passa wrote, each new step once, and where the domain went live', async () => {
    const { invoke, calls } = scripted(
      report({ waiting: [{ record: validation }] }),
      report({ waiting: [{ record: validation }] }),
      report({}),
      report({ step: 'attaching' }),
      report({ step: 'deploying', tenant: 'dt_1' }),
      report({ step: 'live', primary: true }),
    );
    const lines = await run((p) => addDomain(invoke, { domain: 'docs.example.com', site: 'docs', tenant: 'new' }, p));
    expect(lines).toEqual([
      'Adding docs.example.com to docs (a tenant of its own).',
      '  DNS records, written in Route 53:',
      '    CNAME docs.example.com  →  d111.cloudfront.net',
      '    CNAME _v.docs.example.com  →  _t.acm-validations.aws',
      '  Waiting for DNS: 1 record not resolving yet…',
      '  Waiting for the certificate…',
      '  Attaching the domain to CloudFront…',
      '  Waiting for CloudFront to deploy it…',
      'Live: https://docs.example.com/ is now docs\'s address; its other addresses redirect there.',
    ]);
    expect(calls[0]).toEqual({ action: 'domain.add', domain: 'docs.example.com', site: 'docs', tenant: 'new' });
  });

  it('asks a person to add the records at another DNS host, with the apex rule, and shows problems once', async () => {
    const apex: DnsRecord = { ...pointer, name: 'example.com', type: 'A', alias: true };
    const proxied = 'example.com resolves to Cloudflare: its record is proxied (orange cloud).';
    const { invoke } = scripted(
      report({ dns: 'manual', records: [apex, validation], waiting: [{ record: apex, problem: proxied }, { record: validation }] }),
      report({ dns: 'manual', records: [apex, validation], waiting: [{ record: apex, problem: proxied }] }),
      report({ step: 'live', primary: true, domain: 'example.com' }),
    );
    const lines = await run((p) => addDomain(invoke, { domain: 'example.com', site: 'docs', tenant: 'fill' }, p));
    expect(lines.slice(1, 6)).toEqual([
      '  Add these records at your DNS host (they can stay):',
      '    ALIAS example.com  →  d111.cloudfront.net',
      '    CNAME _v.docs.example.com  →  _t.acm-validations.aws',
      '    The apex needs an ALIAS, ANAME or flattened CNAME record; a plain CNAME isn\'t allowed there.',
      `  problem: ${proxied}`,
    ]);
    expect(lines.filter((l) => l.includes('proxied'))).toHaveLength(1);
  });

  it('shows records as they appear, such as validation once the certificate is requested', async () => {
    const { invoke } = scripted(report({ records: [pointer], waiting: [{ record: pointer }] }), report({}), report({ step: 'live', primary: true }));
    const lines = await run((p) => addDomain(invoke, { domain: 'docs.example.com', site: 'docs', tenant: 'new' }, p));
    expect(lines.filter((l) => l.startsWith('    CNAME'))).toEqual(['    CNAME docs.example.com  →  d111.cloudfront.net', '    CNAME _v.docs.example.com  →  _t.acm-validations.aws']);
  });

  it('stops after a while and says to run it again, since it resumes', async () => {
    let t = 0;
    const { invoke } = scripted(report({ waiting: [{ record: pointer }] }));
    const lines: string[] = [];
    const r = await addDomain(invoke, { domain: 'docs.example.com', site: 'docs', tenant: 'new' }, { out: (l) => lines.push(l), wait: async () => { t += 60_000; }, now: () => t, maxMs: 120_000 });
    expect(r.step).toBe('certificate');
    expect(lines.at(-1)).toMatch(/Run the same command again to carry on/);
  });
});

describe('passa admin domain remove, list and status', () => {
  it('follows a removal until the domain is gone', async () => {
    const { invoke } = scripted(report({ step: 'detaching' }), report({ step: 'detaching' }), report({ step: 'gone' }));
    const lines = await run((p) => removeDomain(invoke, { domain: 'docs.example.com' }, p));
    expect(lines).toEqual(['Removing docs.example.com.', '  Detaching it from CloudFront…', expect.stringMatching(/^Removed\./)]);
  });

  it('lists domains with their tenant and how full it is', () => {
    const lines = formatList({ domains: [{ domain: 'docs.example.com', site: 'docs', role: 'primary', step: 'live', dns: 'route53', tenant: 'dt_1', primary: true }, { domain: 'www.docs.example.com', site: 'docs', role: 'alias', step: 'live', dns: 'route53', tenant: 'dt_1' }], tenants: { dt_1: 2 } });
    expect(lines).toEqual([
      'DOMAIN                SITE  ROLE     STATE  TENANT (NAMES)',
      'docs.example.com      docs  primary  live   dt_1 (2)',
      'www.docs.example.com  docs  alias    live   dt_1 (2)',
    ]);
    expect(formatList({ domains: [], tenants: {} })[0]).toMatch(/No custom domains yet/);
  });

  it('marks which records resolve in a status', () => {
    const lines = formatStatus(report({ dns: 'manual', waiting: [{ record: validation }] }));
    expect(lines).toEqual([
      'docs.example.com: certificate on docs (primary)',
      '  DNS: added by you at the DNS host',
      '    ✓ CNAME docs.example.com  →  d111.cloudfront.net',
      '    ✗ CNAME _v.docs.example.com  →  _t.acm-validations.aws  (not resolving yet)',
    ]);
  });
});
