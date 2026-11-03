// passa admin domain end to end (M4 R113–R117): the real store, publisher and
// edge on the local stack, with CloudFront and ACM in memory and DNS faked.
import type { ACMClient } from '@aws-sdk/client-acm';
import type { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { sendTo, type Stack, startStack } from '@passa/edge/testing';
import { addUser, type TestEnv } from '@passa/mcp/testing';
import type { DnsProvider, DnsRecord, Rule } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CloudFrontDomains } from './cloudfront.ts';
import { ManualDns } from './dns.ts';
import { AdminDomains, type DomainReport } from './domains.ts';
import { FakeAws } from './testing.ts';

let env: TestEnv;
let stack: Stack;
let port: number;
const alice = { userId: 'alice' };

// Route 53 for example.test only, remembering what it holds.
class FakeRoute53 implements DnsProvider {
  readonly kind = 'route53';
  records = new Map<string, DnsRecord>();
  async zoneFor(domain: string) {
    return domain === 'example.test' || domain.endsWith('.example.test') ? { id: 'Z1', name: 'example.test' } : undefined;
  }
  async upsert(records: DnsRecord[]) {
    for (const r of records) this.records.set(`${r.name} ${r.type}`, r);
  }
  async remove(records: DnsRecord[]) {
    for (const r of records) this.records.delete(`${r.name} ${r.type}`);
  }
}

let aws: FakeAws;
let route53: FakeRoute53;
let admin: AdminDomains;

beforeAll(async () => {
  stack = await startStack();
  ({ env, port } = stack);
  await addUser(env, { id: 'alice' });
  aws = new FakeAws();
  route53 = new FakeRoute53();
  admin = new AdminDomains({
    store: env.store,
    events: env.events,
    config: { ...env.config, siteDomain: 'localhost' },
    publisher: stack.publisher,
    provider: new CloudFrontDomains(aws as unknown as CloudFrontClient, aws as unknown as ACMClient, { distributionId: 'EDIST', connectionGroupId: 'cg_1', prefix: 'passa-test', namesPerTenant: 10 }),
    dns: route53,
    manual: new ManualDns(),
    // Records Passa wrote resolve at once; others (manual) never do here.
    pending: async (records) => records.filter((r) => !route53.records.has(`${r.name} ${r.type}`)).map((record) => ({ record })),
  });
});

afterAll(() => stack.close());

const file = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text) });
async function site(title: string, name: string, rules: Rule[] = [{ path: '/', tier: 'public' }]) {
  const s = await stack.publisher.publish(alice, { title, content: { files: [file('index.md', `# ${title}\n\nHello.`)] }, rules, confirmPublic: true });
  await stack.publisher.setName(alice, { siteId: s.site_id, name });
  return s.site_id;
}

// Calls add until the domain is live, letting AWS move on whenever it waits.
async function addToLive(domain: string, siteLabel: string, tenant: 'fill' | 'new', primary?: boolean) {
  let report: DomainReport | undefined;
  for (let i = 0; i < 8; i++) {
    report = await admin.add({ domain, site: siteLabel, tenant, ...(primary ? { primary } : {}) });
    if (report.step === 'live') return report;
    aws.issue();
    aws.deploy();
  }
  throw new Error(`${domain} didn't go live: ${JSON.stringify(report)}`);
}

async function removeToGone(domain: string) {
  let report: DomainReport | undefined;
  for (let i = 0; i < 8; i++) {
    report = await admin.remove({ domain });
    if (report.step === 'gone') return report;
    aws.issue();
    aws.deploy();
  }
  throw new Error(`${domain} wasn't removed: ${JSON.stringify(report)}`);
}

const get = (host: string, path = '/') => sendTo(port, `${host}:${port}`, path);

describe('passa admin domain', () => {
  it('adds a domain in a managed zone: writes its records, waits, and switches the site once it serves', async () => {
    const id = await site('Docs', 'docs-site');
    const first = await admin.add({ domain: 'docs.example.test', site: 'docs-site', tenant: 'new' });
    expect(first).toMatchObject({ step: 'certificate', role: 'primary', dns: 'route53', site: 'docs-site' });
    expect([...route53.records.keys()].sort()).toEqual(['_v.docs.example.test. CNAME', 'docs.example.test CNAME']);
    // Not live yet: the site keeps its name.
    expect((await get('docs-site.localhost')).status).toBe(200);

    const live = await addToLive('docs.example.test', 'docs-site', 'new');
    expect(live).toMatchObject({ step: 'live', primary: true });
    expect((await env.store.getSite(id))?.domain).toBe('docs.example.test');
    expect((await get('docs.example.test')).status).toBe(200);
    expect((await get('docs-site.localhost', '/x/')).headers.location).toBe(`http://docs.example.test:${port}/x/`);
  });

  it('adds an alias to the same tenant with --fill-tenant, and --primary swaps them', async () => {
    const id = await site('Blog', 'a-blog');
    await addToLive('blog.example.test', 'a-blog', 'new');
    const tenantsBefore = aws.tenants.size;
    const alias = await addToLive('www.blog.example.test', 'a-blog', 'fill');
    // It joined a tenant with room (the first one), rather than starting one.
    expect(aws.tenants.size).toBe(tenantsBefore);
    expect(alias.role).toBe('alias');
    expect((await get('www.blog.example.test', '/p/')).headers.location).toBe(`http://blog.example.test:${port}/p/`);

    const swapped = await admin.add({ domain: 'www.blog.example.test', site: 'a-blog', tenant: 'fill', primary: true });
    expect(swapped).toMatchObject({ role: 'primary', primary: true });
    expect((await env.store.getSite(id))?.domain).toBe('www.blog.example.test');
    expect((await env.store.getDomain('blog.example.test'))?.role).toBe('alias');
    expect((await get('blog.example.test', '/p/')).headers.location).toBe(`http://www.blog.example.test:${port}/p/`);

    const { domains, tenants } = await admin.list();
    const blog = domains.filter((d) => d.site === 'a-blog');
    expect(blog.map((d) => [d.domain, d.role])).toEqual(expect.arrayContaining([['blog.example.test', 'alias'], ['www.blog.example.test', 'primary']]));
    expect(tenants[blog.find((d) => d.domain === 'www.blog.example.test')?.tenant ?? '']).toBe(2);
  });

  it('removes the primary: the site moves to its alias first, then the domain and its records go', async () => {
    const id = await site('Notes', 'my-notes');
    await addToLive('notes.example.test', 'my-notes', 'new');
    await addToLive('www.notes.example.test', 'my-notes', 'fill');
    const gone = await removeToGone('notes.example.test');
    expect(gone.step).toBe('gone');
    expect((await env.store.getSite(id))?.domain).toBe('www.notes.example.test');
    expect(await env.store.getDomain('notes.example.test')).toBeUndefined();
    expect(route53.records.has('notes.example.test CNAME')).toBe(false);
    expect((await get('notes.example.test')).status).toBe(404);

    await removeToGone('www.notes.example.test');
    const back = await env.store.getSite(id);
    expect([back?.domain, back?.domains]).toEqual([undefined, undefined]);
    expect((await get('my-notes.localhost')).status).toBe(200);
  });

  it('leaves records for domains outside its zones to a person, and keeps waiting for them', async () => {
    await site('Elsewhere', 'elsewhere');
    const r = await admin.add({ domain: 'docs.example.org', site: 'elsewhere', tenant: 'new' });
    expect(r.dns).toBe('manual');
    expect(r.waiting.map((w) => w.record.purpose).sort()).toEqual(['pointer', 'validation']);
    expect([...route53.records.keys()].some((k) => k.includes('example.org'))).toBe(false);
    await removeToGone('docs.example.org');
  });

  it('refuses the site domain, a domain another site has, and a site that does not exist', async () => {
    await site('One', 'site-one');
    await site('Two', 'site-two');
    await expect(admin.add({ domain: 'x.localhost', site: 'site-one', tenant: 'new' })).rejects.toThrow(/under the site domain/);
    await admin.add({ domain: 'one.example.test', site: 'site-one', tenant: 'new' });
    await expect(admin.add({ domain: 'one.example.test', site: 'site-two', tenant: 'new' })).rejects.toThrow(/attached to another site/);
    await expect(admin.add({ domain: 'z.example.test', site: 'no-such-site', tenant: 'new' })).rejects.toThrow(/No site no-such-site/);
    await removeToGone('one.example.test');
  });
});
