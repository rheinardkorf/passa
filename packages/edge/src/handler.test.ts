import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffUrl, MemoryEdgeStore, NAME_PATTERN, newSiteId, SITE_ID_PATTERN, siteCookie } from '@passa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { functionCode, MAX_FUNCTION_BYTES } from './build.ts';
import { type EdgeRequest, type EdgeResponse, isResponse, loadHandler } from './load.ts';

const handle = loadHandler();
const crypto = { createHmac: (a: string, k: string) => createHmac(a, k) };
const NOW = Date.parse('2026-10-29T00:00:00Z');
const now = NOW / 1000;
const SITE = 'brave-otter-k3x9qm';
const VERSION = '01JB0000000000000000000000';
const key = { kid: 'k1', secret: 'a'.repeat(64) };
let kvs: MemoryEdgeStore;

beforeEach(async () => {
  kvs = new MemoryEdgeStore();
  kvs.values.set('k:k1', key.secret);
  await kvs.put(SITE, { cur: VERSION, v: 1, r: [] });
});

function request(uri: string, extra: { host?: string; cookie?: string; query?: Record<string, string> } = {}): { request: EdgeRequest } {
  const querystring = Object.fromEntries(Object.entries(extra.query ?? {}).map(([k, value]) => [k, { value }]));
  return {
    request: {
      method: 'GET',
      uri,
      querystring,
      headers: { host: { value: extra.host ?? `${SITE}.example.com` } },
      cookies: extra.cookie ? { '__Host-passa': { value: extra.cookie } } : {},
    },
  };
}

const domains = { sites: 'example.com', auth: 'https://auth.example.com' };
const run = (event: { request: EdgeRequest }) => handle(event, { kvs, crypto, now: NOW, ...domains });
const cookie = (overrides: Partial<{ siteId: string; accessVersion: number; expires: number; key: typeof key }> = {}) =>
  siteCookie({ key, siteId: SITE, accessVersion: 1, expires: now + 600, ...overrides });

async function response(event: { request: EdgeRequest }): Promise<EdgeResponse> {
  const result = await run(event);
  if (!isResponse(result)) throw new Error(`expected a response, got a rewrite to ${result.uri}`);
  return result;
}

async function rewrite(event: { request: EdgeRequest }): Promise<string> {
  const result = await run(event);
  if (isResponse(result)) throw new Error(`expected a rewrite, got ${result.statusCode}`);
  return result.uri;
}

const signinFor = (path: string) => `https://auth.example.com/site/signin?site=${SITE}&path=${encodeURIComponent(path)}`;

describe('with a valid site cookie', () => {
  it('rewrites to the current version, with index.html for folders (R11, R13)', async () => {
    const c = cookie();
    expect(await rewrite(request('/', { cookie: c }))).toBe(`/${SITE}/${VERSION}/index.html`);
    expect(await rewrite(request('/docs/', { cookie: c }))).toBe(`/${SITE}/${VERSION}/docs/index.html`);
    expect(await rewrite(request('/docs', { cookie: c }))).toBe(`/${SITE}/${VERSION}/docs/index.html`);
    expect(await rewrite(request('/css/site.css', { cookie: c }))).toBe(`/${SITE}/${VERSION}/css/site.css`);
  });

  it('follows the edge record when the current version changes', async () => {
    await kvs.put(SITE, { cur: '01JB1111111111111111111111', v: 1, r: [] });
    expect(await rewrite(request('/', { cookie: cookie() }))).toBe(`/${SITE}/01JB1111111111111111111111/index.html`);
  });

  it('strips cookies and query strings before the origin', async () => {
    const result = (await run({ ...request('/', { cookie: cookie(), query: { a: '1' } }) })) as EdgeRequest;
    expect(result.cookies).toEqual({});
    expect(result.querystring).toEqual({});
  });
});

describe('without a valid cookie (R10, R12)', () => {
  it('redirects to sign in', async () => {
    const r = await response(request('/docs/a.html'));
    expect(r.statusCode).toBe(302);
    expect(r.headers.location?.value).toBe(signinFor('/docs/a.html'));
    expect(r.headers['cache-control']?.value).toBe('no-store');
  });

  it('refuses cookies that are expired, for another site, from an older access version, or forged', async () => {
    await kvs.put('quiet-river-m7wp2c', { cur: VERSION, v: 1, r: [] });
    const bad = [
      cookie({ expires: now - 1 }),
      cookie({ siteId: 'quiet-river-m7wp2c' }),
      cookie({ accessVersion: 0 }),
      cookie({ key: { kid: 'k1', secret: 'b'.repeat(64) } }),
      cookie({ key: { kid: 'k9', secret: key.secret } }),
      cookie().replace(/.$/, (c) => (c === '0' ? '1' : '0')),
      'garbage',
    ];
    for (const c of bad) expect((await response(request('/', { cookie: c }))).headers.location?.value, c).toBe(signinFor('/'));
  });

  it('treats a site with no edge record exactly like a private one', async () => {
    const missing = 'calm-heron-zzzzzz';
    const r = await response(request('/', { host: `${missing}.example.com` }));
    expect(r.headers.location?.value).toBe(`https://auth.example.com/site/signin?site=${missing}&path=%2F`);
    // Even with a cookie that would be valid if the site existed.
    const c = siteCookie({ key, siteId: missing, accessVersion: 1, expires: now + 600 });
    expect((await response(request('/', { host: `${missing}.example.com`, cookie: c }))).statusCode).toBe(302);
  });
});

describe('public paths (M2 R32, R33, R39)', () => {
  const rules = (r: unknown) => kvs.put(SITE, { cur: VERSION, v: 1, r } as never);

  it('serves a public site without a cookie, stripping cookies and query strings', async () => {
    await rules([['/', 'p']]);
    expect(await rewrite(request('/'))).toBe(`/${SITE}/${VERSION}/index.html`);
    expect(await rewrite(request('/css/site.css'))).toBe(`/${SITE}/${VERSION}/css/site.css`);
    const result = (await run(request('/', { cookie: 'anything', query: { a: '1' } }))) as EdgeRequest;
    expect([result.cookies, result.querystring]).toEqual([{}, {}]);
  });

  it('keeps a private folder inside a public site private, matching the path as served', async () => {
    await rules([['/notes/', 'x'], ['/', 'p']]);
    for (const uri of ['/notes/', '/notes', '/notes/a.html']) expect((await response(request(uri))).headers.location?.value, uri).toBe(signinFor(uri));
    for (const uri of ['/', '/notes.html', '/notesx/']) expect(await rewrite(request(uri)), uri).toContain(`/${SITE}/${VERSION}/`);
    // The owner still gets in with a cookie.
    expect(await rewrite(request('/notes/', { cookie: cookie() }))).toBe(`/${SITE}/${VERSION}/notes/index.html`);
  });

  it('makes only a public folder public in a private site', async () => {
    await rules([['/docs/', 'p']]);
    expect(await rewrite(request('/docs'))).toBe(`/${SITE}/${VERSION}/docs/index.html`);
    expect(await rewrite(request('/docs/a.png'))).toBe(`/${SITE}/${VERSION}/docs/a.png`);
    for (const uri of ['/', '/docs.html', '/other/']) expect((await response(request(uri))).statusCode, uri).toBe(302);
  });

  it('still refuses reserved and impossible paths', async () => {
    await rules([['/', 'p']]);
    for (const uri of ['/_passa', '/_passa/x.html', '/../x', '/.env']) expect((await response(request(uri))).statusCode, uri).toBe(404);
  });

  it('treats malformed rules as private', async () => {
    for (const r of ['/', [['/', 'P']], [[1, 'p']], [['/']], [null], { '/': 'p' }]) {
      await rules(r);
      expect((await response(request('/'))).statusCode, JSON.stringify(r)).toBe(302);
    }
  });
});

describe('named sites (M2 R44, R45)', () => {
  const named = async (n?: string) => kvs.put(SITE, { cur: VERSION, v: 1, r: [], ...(n ? { n } : {}) });
  const at = (host: string, uri = '/', extra: { cookie?: string } = {}) => request(uri, { ...extra, host: `${host}.example.com` });

  beforeEach(async () => {
    await kvs.putName('cv', SITE);
    await named('cv');
  });

  it('serves a named site at its name, checking the same cookie', async () => {
    expect(await rewrite(at('cv', '/docs/', { cookie: cookie() }))).toBe(`/${SITE}/${VERSION}/docs/index.html`);
    expect((await response(at('cv', '/docs/'))).headers.location?.value).toBe(`https://auth.example.com/site/signin?site=cv&path=${encodeURIComponent('/docs/')}`);
  });

  it('redirects the ID address to the name, keeping the path', async () => {
    const r = await response(at(SITE, '/docs/a.html', { cookie: cookie() }));
    expect([r.statusCode, r.headers.location?.value, r.headers['cache-control']?.value]).toEqual([302, 'https://cv.example.com/docs/a.html', 'no-store']);
  });

  it('redirects a held name to the current one, or to the ID once the name is removed', async () => {
    await kvs.putName('resume', SITE);
    await named('resume');
    expect((await response(at('cv', '/x.html'))).headers.location?.value).toBe('https://resume.example.com/x.html');
    await named();
    expect((await response(at('cv', '/x.html'))).headers.location?.value).toBe(`https://${SITE}.example.com/x.html`);
    expect(await rewrite(at(SITE, '/', { cookie: cookie() }))).toBe(`/${SITE}/${VERSION}/index.html`);
  });

  it('makes an unknown name look exactly like a private site (R12)', async () => {
    const unknown = await response(at('nothing-here', '/'));
    const known = await response(at('cv', '/'));
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers.location?.value.replace('nothing-here', 'cv')).toBe(known.headers.location?.value);
    // A name whose site has no record (deleted, blocked) too.
    await kvs.remove(SITE);
    expect((await response(at('cv', '/'))).headers.location?.value).toBe(known.headers.location?.value);
  });

  it('refuses a cookie for another site when a name has moved', async () => {
    const other = 'quiet-river-m7wp2c';
    await kvs.put(other, { cur: VERSION, v: 1, r: [], n: 'cv' });
    await kvs.putName('cv', other);
    expect((await response(at('cv', '/', { cookie: cookie() }))).statusCode).toBe(302);
  });

  it('hands sign-in back on the name host, and waits for a new name to reach the edge', async () => {
    const event = (host: string) => {
      const url = new URL(handoffUrl({ key, siteId: SITE, accessVersion: 1, origin: `https://${host}.example.com`, path: '/', cookieLifetime: 3600, now: NOW }));
      const query = Object.fromEntries(url.search.slice(1).split('&').map((p) => p.split('=') as [string, string]));
      return { request: { ...request(url.pathname, { query }).request, headers: { host: { value: `${host}.example.com` } } } };
    };
    expect((await response(event('cv'))).cookies?.['__Host-passa']?.value).toBe(cookie({ expires: now + 3600 }));
    expect((await response(event('fresh-name'))).statusCode).toBe(503);
  });

  it('serves public paths at the name without a cookie', async () => {
    await kvs.put(SITE, { cur: VERSION, v: 1, r: [['/', 'p']], n: 'cv' });
    expect(await rewrite(at('cv', '/'))).toBe(`/${SITE}/${VERSION}/index.html`);
    expect((await response(at(SITE, '/'))).headers.location?.value).toBe('https://cv.example.com/');
  });
});

describe('paths', () => {
  it('returns 404 for paths that no published file can have', async () => {
    const c = cookie();
    for (const uri of ['/../x', '/a/../b', '/%2e%2e/x', '/.env', '/a//b', '/a b', '/ü.html']) {
      expect((await response(request(uri, { cookie: c }))).statusCode, uri).toBe(404);
    }
  });

  it('never serves /_passa/ from storage (R14)', async () => {
    for (const uri of ['/_passa', '/_passa/', '/_passa/x.html']) expect((await response(request(uri, { cookie: cookie() }))).statusCode, uri).toBe(404);
  });

  it('uses the same site ID and name patterns as the publisher', () => {
    const source = readFileSync(new URL('./handler.js', import.meta.url), 'utf8');
    expect(/const SITE_ID = \/(.+)\/;/.exec(source)?.[1]).toBe(SITE_ID_PATTERN.source);
    expect(/const NAME = \/(.+)\/;/.exec(source)?.[1]).toBe(NAME_PATTERN.source);
  });

  it('accepts every site ID the publisher can generate', async () => {
    for (let i = 0; i < 2000; i++) {
      const id = newSiteId();
      const r = await response(request('/', { host: `${id}.example.com` }));
      expect(r.statusCode, id).toBe(302);
    }
  });

  it('returns 404 for hosts that are neither site IDs nor names on the site domain', async () => {
    const hosts = ['example.com', 'my--cv.example.com', '-cv.example.com', 'a.example.com', `${'a'.repeat(41)}.example.com`, `${SITE}.example.org`, `${SITE}.example.com.evil.org`, `x.${SITE}.example.com`, `${SITE}example.com`];
    for (const host of hosts) expect((await response(request('/', { host }))).statusCode, host).toBe(404);
  });
});

describe('with a separate site domain', () => {
  const separate = (event: { request: EdgeRequest }) => handle(event, { kvs, crypto, now: NOW, sites: 'example-sites.com', auth: 'https://auth.example.com' });

  it('serves sites from it and signs in on the main domain', async () => {
    const result = await separate(request('/', { host: `${SITE}.example-sites.com` }));
    expect(isResponse(result) && result.headers.location?.value).toBe(signinFor('/'));
    const served = await separate(request('/', { host: `${SITE}.example-sites.com`, cookie: cookie() }));
    expect(isResponse(served) ? served.statusCode : served.uri).toBe(`/${SITE}/${VERSION}/index.html`);
  });

  it('no longer answers on the main domain', async () => {
    const result = await separate(request('/', { cookie: cookie() }));
    expect(isResponse(result) && result.statusCode).toBe(404);
  });
});

describe('sign-in handoff', () => {
  function handoff(overrides: Partial<Parameters<typeof handoffUrl>[0]> = {}) {
    const url = new URL(handoffUrl({ key, siteId: SITE, accessVersion: 1, origin: `https://${SITE}.example.com`, path: '/docs/', cookieLifetime: 3600, now: NOW, ...overrides }));
    // As the proxy passes them: undecoded.
    const query = Object.fromEntries(url.search.slice(1).split('&').map((p) => p.split('=') as [string, string]));
    return request(url.pathname, { query });
  }

  it('sets a host-only site cookie and redirects to the page', async () => {
    const r = await response(handoff());
    expect(r.statusCode).toBe(302);
    expect(r.headers.location?.value).toBe('/docs/');
    const set = r.cookies?.['__Host-passa'];
    expect(set?.attributes).toBe('Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax');
    // The cookie it sets is accepted.
    expect(await rewrite(request('/docs/', { cookie: set?.value ?? '' }))).toBe(`/${SITE}/${VERSION}/docs/index.html`);
    expect(set?.value).toBe(cookie({ expires: now + 3600 }));
  });

  it('refuses tokens that are expired, for another site or an older access version, or tampered with', async () => {
    const cases = [
      handoff({ now: NOW - 61_000 }),
      handoff({ siteId: 'quiet-river-m7wp2c' }),
      handoff({ accessVersion: 0 }),
      handoff({ key: { kid: 'k1', secret: 'b'.repeat(64) } }),
    ];
    const longer = handoff();
    longer.request.querystring.l = { value: '86400' };
    const elsewhere = handoff();
    elsewhere.request.querystring.p = { value: '%2Fother' };
    const offsite = handoff({ path: '//evil.example' });
    for (const event of [...cases, longer, elsewhere, offsite]) expect((await response(event)).statusCode).toBe(404);
  });

  it('waits, instead of failing, while a new site or access version reaches the edge', async () => {
    const fresh = 'amber-comet-q2r3s4';
    const forFresh = () => {
      const event = handoff({ siteId: fresh, origin: `https://${fresh}.example.com` });
      event.request.headers.host = { value: `${fresh}.example.com` };
      return event;
    };
    const waiting = await response(forFresh());
    expect([waiting.statusCode, waiting.headers['retry-after']?.value]).toEqual([503, '2']);
    expect(waiting.body?.data).toContain('http-equiv="refresh" content="2"');
    expect(waiting.body?.data).toContain('content="light dark"');
    expect((await response(handoff({ accessVersion: 2 }))).statusCode).toBe(503);
    // Once the record arrives, the same token works.
    await kvs.put(fresh, { cur: VERSION, v: 1, r: [] });
    expect((await response(forFresh())).statusCode).toBe(302);
    await kvs.remove(fresh);
  });

  it('does not accept a handoff token as a cookie, or a cookie as a handoff token', async () => {
    const token = handoff().request.querystring.t?.value ?? '';
    expect((await response(request('/', { cookie: token }))).statusCode).toBe(302);
    const asToken = request('/_passa/session', { query: { t: cookie(), l: '3600', p: '%2F' } });
    expect((await response(asToken)).statusCode).toBe(404);
  });
});

describe('the CloudFront build', () => {
  it('fits the size limit and defines the runtime entry point', () => {
    const code = functionCode('a1b2c3d4-0000-4000-8000-000000000000', { domain: 'example.com', siteDomain: 'example-sites.com' });
    expect(Buffer.byteLength(code)).toBeLessThan(MAX_FUNCTION_BYTES);
    expect(code).toMatch(/^import cf from 'cloudfront';/);
    expect(code).toContain('async function handler(event)');
    expect(code).toContain(`sites: "example-sites.com", auth: "https://auth.example.com"`);
    expect(functionCode('a1b2c3d4-0000-4000-8000-000000000000', { domain: 'example.com' })).toContain(`sites: "example.com", auth: "https://auth.example.com"`);
    // Parses as a module, the way CloudFront loads it.
    const file = join(mkdtempSync(join(tmpdir(), 'passa-edge-')), 'function.mjs');
    writeFileSync(file, code);
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });
});
