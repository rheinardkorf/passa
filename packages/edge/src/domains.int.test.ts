// Custom domains end to end (M4 R122–R126): a site given domains the way the
// admin function will (claim, then setDomains once live), browsed through the
// local proxy with each domain's Host. No DNS: requests carry the Host.
import type { Publisher } from '@passa/mcp';
import { addUser, type TestEnv } from '@passa/mcp/testing';
import type { Domain, Rule } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, sendTo, type Stack, startStack } from './testing.ts';

let env: TestEnv;
let stack: Stack;
let port: number;
let publisher: Publisher;
let sent: { text: string }[] = [];
const alice = { userId: 'alice' };

beforeAll(async () => {
  stack = await startStack();
  ({ env, port, publisher, sent } = stack);
  await addUser(env, { id: 'alice' });
});

afterAll(() => stack.close());

const get = (host: string, path = '/') => sendTo(port, `${host}:${port}`, path);
const claim = (domain: string, siteId: string, role: Domain['role']) => {
  const at = new Date().toISOString();
  return env.store.claimDomain({ domain, siteId, role, step: 'live', records: [], wrote: [], createdAt: at, updatedAt: at });
};

const file = (path: string, text: string) => ({ path, content: new TextEncoder().encode(text) });

async function markdownSite(title: string, rules: Rule[] = [{ path: '/', tier: 'public' }]) {
  return publisher.publish(alice, {
    title,
    content: { files: [file('index.md', `---\ntitle: ${title}\n---\n# ${title}\n\nA page about ${title}.`), file('guide.md', '# Guide\n\nHow to.')] },
    rules,
    confirmPublic: true,
  });
}

describe('a site at its custom domain', () => {
  it('serves at the primary domain, with its links following it, and everything else redirecting there', async () => {
    const site = await markdownSite('Docs');
    await publisher.setName(alice, { siteId: site.site_id, name: 'the-docs' });
    await claim('docs.example.test', site.site_id, 'primary');
    await claim('www.docs.example.test', site.site_id, 'alias');
    const result = await publisher.setDomains(site.site_id, ['docs.example.test', 'www.docs.example.test'], 'docs.example.test');
    expect(result).toMatchObject({ url: `http://docs.example.test:${port}/`, domain: 'docs.example.test', domains: ['docs.example.test', 'www.docs.example.test'] });
    // R124: the Markdown was rendered again for the new address.
    expect(result).toHaveProperty('version_id');

    const page = await get('docs.example.test', '/guide/');
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<meta property="og:url" content="http://docs.example.test:${port}/guide/">`);
    expect(page.headers['x-robots-tag']).toBeUndefined(); // R125

    for (const host of ['www.docs.example.test', 'the-docs.localhost', `${site.site_id}.localhost`]) {
      const r = await get(host, '/guide/');
      expect([host, r.status, r.headers.location]).toEqual([host, 302, `http://docs.example.test:${port}/guide/`]);
    }
    expect((await get('elsewhere.example.test')).status).toBe(404);
  });

  it('goes back to its name when its domains are removed, and lets go of them at the edge', async () => {
    const site = await markdownSite('Blog');
    await publisher.setName(alice, { siteId: site.site_id, name: 'a-blog' });
    await claim('blog.example.test', site.site_id, 'primary');
    await publisher.setDomains(site.site_id, ['blog.example.test'], 'blog.example.test');
    const back = await publisher.setDomains(site.site_id, [], undefined);
    expect(back.url).toBe(`http://a-blog.localhost:${port}/`);
    expect((await get('a-blog.localhost', '/guide/')).body).toContain(`content="http://a-blog.localhost:${port}/guide/"`);
    expect((await get('blog.example.test')).status).toBe(404);
  });

  it('refuses a primary that is not one of its domains, and a domain another site has', async () => {
    const site = await markdownSite('Other');
    await expect(publisher.setDomains(site.site_id, ['x.example.test'], 'y.example.test')).rejects.toThrow(/primary domain/);
    await expect(publisher.setDomains(site.site_id, ['x.example.test'], undefined)).rejects.toThrow(/primary domain/);
    await claim('taken.example.test', site.site_id, 'primary');
    await expect(claim('taken.example.test', 'some-other-site', 'primary')).rejects.toThrow('taken.example.test');
  });

  it('signs the owner in to a private site at its domain, end to end (R123)', async () => {
    const site = await markdownSite('Private notes', []);
    await claim('notes.example.test', site.site_id, 'primary');
    await publisher.setDomains(site.site_id, ['notes.example.test'], 'notes.example.test');
    const browser = new Browser(port);
    const start = await browser.open(`http://notes.example.test:${port}/guide/`);
    expect(start.status).toBe(302);
    const signin = new URL(String(start.headers.location));
    expect([signin.searchParams.get('site'), signin.searchParams.get('path')]).toEqual(['notes.example.test', '/guide/']);

    await browser.open(signin.href);
    await browser.open(`http://localhost:${port}/signin`, { email: 'alice@example.com', site: 'notes.example.test', path: '/guide/' });
    const link = /(http:\/\/localhost:\d+\/signin\/continue)#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '');
    expect(link).not.toBeNull();
    const landed = await browser.follow(link?.[1] ?? '', { token: link?.[2] ?? '' });
    // The handoff lands on the domain, with the cookie for that host only.
    expect(landed.url.host).toBe(`notes.example.test:${port}`);
    expect(landed.status).toBe(200);
    expect(landed.body).toContain('How to.');
    expect(browser.jar.get(`notes.example.test:${port}`)?.has('__Host-passa')).toBe(true);
  });

  it('won’t sign anyone in through a domain the site no longer has', async () => {
    const site = await markdownSite('Moved', []);
    await claim('moved.example.test', site.site_id, 'primary');
    // Claimed, but never live on the site: auth. doesn't count it (R123).
    const browser = new Browser(port);
    await browser.open(`http://localhost:${port}/site/signin?site=moved.example.test&path=%2F`);
    const before = sent.length;
    await browser.open(`http://localhost:${port}/signin`, { email: 'alice@example.com', site: 'moved.example.test', path: '/' });
    expect(sent.length).toBe(before); // no email: nobody may view it this way
  });

  it('removes its domains from the edge when the site is purged', async () => {
    const site = await markdownSite('Gone');
    await claim('gone.example.test', site.site_id, 'primary');
    await publisher.setDomains(site.site_id, ['gone.example.test'], 'gone.example.test');
    expect((await get('gone.example.test')).status).toBe(200);
    await publisher.purge(site.site_id);
    await expect(env.edge.get('d:gone.example.test')).rejects.toThrow();
  });
});
