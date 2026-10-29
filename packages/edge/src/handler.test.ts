import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handoffUrl, MemoryEdgeStore, newSiteId, siteCookie } from '@passa/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { functionCode, MAX_FUNCTION_BYTES } from './build.ts';
import { type EdgeRequest, type EdgeResponse, isResponse, loadHandler } from './load.ts';

const handle = loadHandler();
const crypto = { createHmac: (a: string, k: string) => createHmac(a, k) };
const NOW = Date.parse('2026-10-29T00:00:00Z');
const now = NOW / 1000;
const SITE = 'k3x9q2abcdef';
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
    await kvs.put('m2n3p4q5r6s7', { cur: VERSION, v: 1, r: [] });
    const bad = [
      cookie({ expires: now - 1 }),
      cookie({ siteId: 'm2n3p4q5r6s7' }),
      cookie({ accessVersion: 0 }),
      cookie({ key: { kid: 'k1', secret: 'b'.repeat(64) } }),
      cookie({ key: { kid: 'k9', secret: key.secret } }),
      cookie().replace(/.$/, (c) => (c === '0' ? '1' : '0')),
      'garbage',
    ];
    for (const c of bad) expect((await response(request('/', { cookie: c }))).headers.location?.value, c).toBe(signinFor('/'));
  });

  it('treats a site with no edge record exactly like a private one', async () => {
    const missing = 'zzzzzzzzzzzz';
    const r = await response(request('/', { host: `${missing}.example.com` }));
    expect(r.headers.location?.value).toBe(`https://auth.example.com/site/signin?site=${missing}&path=%2F`);
    // Even with a cookie that would be valid if the site existed.
    const c = siteCookie({ key, siteId: missing, accessVersion: 1, expires: now + 600 });
    expect((await response(request('/', { host: `${missing}.example.com`, cookie: c }))).statusCode).toBe(302);
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

  it('accepts every site ID the publisher can generate', async () => {
    for (let i = 0; i < 2000; i++) {
      const id = newSiteId();
      const r = await response(request('/', { host: `${id}.example.com` }));
      expect(r.statusCode, id).toBe(302);
    }
  });

  it('returns 404 for hosts that are not site IDs on the site domain', async () => {
    const hosts = ['example.com', 'auth.example.com', 'K3X9Q2ABCDEF0.example.com', 'k3x9q2abcde1.example.com', `${SITE}.example.org`, `${SITE}.example.com.evil.org`, `x.${SITE}.example.com`, `${SITE}example.com`];
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

  it('refuses tokens that are expired, for another site or access version, or tampered with', async () => {
    const cases = [
      handoff({ now: NOW - 61_000 }),
      handoff({ siteId: 'm2n3p4q5r6s7' }),
      handoff({ accessVersion: 2 }),
      handoff({ key: { kid: 'k1', secret: 'b'.repeat(64) } }),
    ];
    const longer = handoff();
    longer.request.querystring.l = { value: '86400' };
    const elsewhere = handoff();
    elsewhere.request.querystring.p = { value: '%2Fother' };
    const offsite = handoff({ path: '//evil.example' });
    for (const event of [...cases, longer, elsewhere, offsite]) expect((await response(event)).statusCode).toBe(404);
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
