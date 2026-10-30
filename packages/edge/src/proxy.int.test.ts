// Sites end to end: publish with the real tools into Moto, then browse through
// the local proxy, which runs the real edge handler, auth app and MCP endpoint.
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Publisher } from '@passa/mcp';
import { addUser, type TestEnv } from '@passa/mcp/testing';
import { contentSecurityPolicy, handoffUrl, type Rule, syncEdge } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './testing.ts';

let env: TestEnv;
let stack: Stack;
let port: number;
let publisher: Publisher;
let sent: { text: string }[] = [];
const key = { kid: 'k1', secret: 'c'.repeat(64) };
const alice = { userId: 'alice' };

beforeAll(async () => {
  stack = await startStack();
  ({ env, port, publisher, sent } = stack);
  await addUser(env, { id: 'alice' });
  await env.edge.set('k:k1', key.secret);
});

afterAll(() => stack.close());

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// Sends a request with a site's Host header to the proxy on 127.0.0.1.
const get = (siteId: string, path: string, headers: Record<string, string> = {}) => send(`${siteId}.localhost:${port}`, path, { headers });

function send(host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host, ...init.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

// A browser's view: cookies kept per host, redirects followed by hand.
class Browser {
  jar = new Map<string, Map<string, string>>();

  async open(url: string, form?: Record<string, string>): Promise<Reply & { url: URL }> {
    const u = new URL(url);
    const cookies = this.jar.get(u.host) ?? new Map<string, string>();
    this.jar.set(u.host, cookies);
    const headers: Record<string, string> = { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body: string | undefined;
    if (form) {
      headers.origin = u.origin;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ ...form, csrf: cookies.get('__Host-passa-csrf') ?? '' }).toString();
    }
    const r = await send(u.host, u.pathname + u.search, { method: form ? 'POST' : 'GET', headers, ...(body ? { body } : {}) });
    for (const c of (r.headers['set-cookie'] as string[] | undefined) ?? []) {
      const pair = c.slice(0, c.indexOf(';'));
      cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    return { ...r, url: u };
  }

  // Follows redirects and continuing pages while they stay on localhost hosts
  // the proxy serves; stops at a page, or at a redirect anywhere else.
  async follow(url: string, form?: Record<string, string>): Promise<Reply & { url: URL }> {
    let reply = await this.open(url, form);
    for (let i = 0; i < 12; i++) {
      const refresh = /content="0;url=([^"]+)"/.exec(reply.body)?.[1]?.replaceAll('&amp;', '&');
      const next = reply.status >= 300 && reply.status < 400 ? String(reply.headers.location) : refresh;
      if (!next) break;
      const to = new URL(next, reply.url);
      if (!to.host.endsWith(`localhost:${port}`)) return { ...reply, url: to };
      reply = await this.open(to.href);
    }
    return reply;
  }
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

// JSON over the proxy, the way an MCP client or OAuth client calls it.
async function call(url: string, init: { body?: unknown; form?: Record<string, string>; token?: string } = {}) {
  const u = new URL(url);
  const headers: Record<string, string> = { accept: 'application/json, text/event-stream' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.body);
  } else if (init.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  }
  const r = await send(u.host, u.pathname + u.search, { method: body ? 'POST' : 'GET', headers, ...(body ? { body } : {}) });
  return { ...r, json: () => JSON.parse(r.body) as Record<string, unknown> };
}

// Follows the sign-in handoff the way a browser would, and returns the cookie.
async function signIn(siteId: string, accessVersion = 1): Promise<string> {
  const url = new URL(handoffUrl({ key, siteId, accessVersion, origin: `http://${siteId}.localhost:${port}`, path: '/', cookieLifetime: 3600 }));
  const r = await get(siteId, url.pathname + url.search);
  expect(r.status).toBe(302);
  const set = (r.headers['set-cookie'] as string[])[0] ?? '';
  return set.slice(0, set.indexOf(';'));
}

const page = (body: string) => [{ path: 'index.html', content: new TextEncoder().encode(`<!doctype html>${body}`) }];

describe('the M1 demo, locally', () => {
  it('connects an agent over OAuth, publishes a page, and shows it to its owner', async () => {
    const mcpUrl = `http://mcp.localhost:${port}/mcp`;
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } };

    // 1. The agent is told where to get a token (R21).
    const anonymous = await call(mcpUrl, { body: initialize });
    expect(anonymous.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(String(anonymous.headers['www-authenticate']))?.[1] ?? '';
    const issuer = String((await call(metadataUrl)).json().authorization_servers?.toString());
    expect(issuer).toBe(`http://localhost:${port}`);
    const as = (await call(`${issuer}/.well-known/oauth-authorization-server`)).json();

    // 2. It registers and sends its user to authorize, with PKCE (R22, R23).
    const reg = (await call(String(as.registration_endpoint), {
      body: { client_name: 'Demo Agent', redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    })).json();
    const { verifier, challenge } = pkce();
    const redirectUri = 'http://127.0.0.1:61234/callback';
    const authorize = `${String(as.authorization_endpoint)}?${new URLSearchParams({
      client_id: String(reg.client_id), redirect_uri: redirectUri, response_type: 'code', scope: 'publish offline_access',
      code_challenge: challenge, code_challenge_method: 'S256', resource: mcpUrl, state: 's1',
    })}`;

    // 3. The user signs in by magic link and allows it (R24).
    const browser = new Browser();
    const signin = await browser.follow(authorize);
    expect(signin.body).toContain('An app wants to publish as you');
    const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
    await browser.open(`${issuer}/signin`, { email: 'alice@example.com', interaction: uid });
    const token = /continue#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
    const consent = await browser.follow(`${issuer}/signin/continue`, { token });
    expect(consent.body).toContain('Demo Agent');
    const confirm = /action="(\/interaction\/[^"]+\/confirm)"/.exec(consent.body)?.[1] ?? '';
    const back = (await browser.follow(`${issuer}${confirm}`, {})).url;
    expect(`${back.origin}${back.pathname}`).toBe(redirectUri);

    // 4. The agent swaps the code for tokens, signed in KMS (Moto's).
    const tokens = (await call(String(as.token_endpoint), {
      form: { grant_type: 'authorization_code', code: back.searchParams.get('code') ?? '', code_verifier: verifier, redirect_uri: redirectUri, client_id: String(reg.client_id), resource: mcpUrl },
    })).json();
    expect(tokens.access_token).toBeTruthy();

    // 5. It publishes, as the user who allowed it (R1).
    const published = await call(mcpUrl, {
      token: String(tokens.access_token),
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'publish', arguments: { title: 'Demo', files: [{ path: 'index.html', content: '<h1>Made by an agent</h1>' }] } } },
    });
    expect(published.status).toBe(200);
    const site = JSON.parse((published.json().result as { content: { text: string }[] }).content[0]?.text ?? '{}') as { url: string };

    // 6. The owner opens the link. Already signed in, there's no second email.
    const emails = sent.length;
    const page = await browser.follow(site.url);
    expect(page.status).toBe(200);
    expect(page.body).toContain('<h1>Made by an agent</h1>');
    expect(sent.length).toBe(emails);
  });
});

describe('signing in', () => {
  it('takes the owner from a site link to the page by magic link, end to end', async () => {
    const site = await publisher.publish(alice, { title: 'Hello', content: { files: page('<h1>Signed in</h1>') } });
    const browser = new Browser();
    const start = await browser.open(site.url);
    expect(start.status).toBe(302);

    const form = await browser.open(String(start.headers.location));
    expect(form.body).toContain('Enter your email');
    await browser.open(`http://localhost:${port}/signin`, { email: 'alice@example.com', site: site.site_id, path: '/' });
    const link = /(http:\/\/localhost:\d+\/signin\/continue)#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '');
    expect(link).not.toBeNull();

    // The fragment stays in the browser; the page's script posts it.
    await browser.open(link?.[1] ?? '');
    const continued = await browser.open(link?.[1] ?? '', { token: link?.[2] ?? '' });
    expect(continued.status).toBe(200);
    const next = (/content="0;url=([^"]+)"/.exec(continued.body)?.[1] ?? '').replaceAll('&amp;', '&');
    const handoff = await browser.open(new URL(next, continued.url).href);
    expect(handoff.status).toBe(302);
    const landed = await browser.open(String(handoff.headers.location));
    expect(landed.status).toBe(302);
    expect(landed.headers.location).toBe('/');
    const pageReply = await browser.open(site.url);
    expect(pageReply.status).toBe(200);
    expect(pageReply.body).toContain('<h1>Signed in</h1>');
  });
});

describe('viewing a private site', () => {
  it('redirects to sign in, then serves the current version with site headers', async () => {
    const site = await publisher.publish(alice, { title: 'Hello', content: { files: [...page('<h1>Hello</h1>'), { path: 'docs/index.html', content: new TextEncoder().encode('docs') }] } });
    expect(site.url).toBe(`http://${site.site_id}.localhost:${port}/`);

    const anonymous = await get(site.site_id, '/');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toBe(`http://localhost:${port}/site/signin?site=${site.site_id}&path=%2F`);

    const cookie = await signIn(site.site_id);
    const r = await get(site.site_id, '/', { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toContain('<h1>Hello</h1>');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe(contentSecurityPolicy(env.config.cdnAllowlist));
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect((await get(site.site_id, '/docs', { cookie })).body).toBe('docs');
    expect((await get(site.site_id, '/missing.html', { cookie })).status).toBe(404);

    // Revalidation: same version, same ETag, no body.
    expect((await get(site.site_id, '/', { cookie, 'if-none-match': String(r.headers.etag) })).status).toBe(304);
  });

  it('shows updates and rollbacks immediately', async () => {
    const site = await publisher.publish(alice, { title: 'Versions', content: { files: page('v1') } });
    const cookie = await signIn(site.site_id);
    await publisher.update(alice, { siteId: site.site_id, content: { files: page('v2') } });
    expect((await get(site.site_id, '/', { cookie })).body).toContain('v2');
    await publisher.rollback(alice, { siteId: site.site_id, versionId: site.current_version });
    expect((await get(site.site_id, '/', { cookie })).body).toContain('v1');
  });

  it('stops serving a site as soon as it is deleted', async () => {
    const site = await publisher.publish(alice, { title: 'Going', content: { files: page('bye') } });
    const cookie = await signIn(site.site_id);
    await publisher.delete(alice, { siteId: site.site_id, now: false });
    const r = await get(site.site_id, '/', { cookie });
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toContain('/site/signin');
  });

  it('refuses a cookie for one site on another', async () => {
    const a = await publisher.publish(alice, { title: 'A', content: { files: page('a') } });
    const b = await publisher.publish(alice, { title: 'B', content: { files: page('b') } });
    const cookie = await signIn(a.site_id);
    expect((await get(b.site_id, '/', { cookie })).status).toBe(302);
  });

  it('only allows GET and HEAD', async () => {
    const r = await new Promise<number>((resolve) => {
      httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { host: `abcdefghijkm.localhost:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(r).toBe(405);
  });
});

describe('viewing a public site (M2)', () => {
  // set_access arrives in step 2; until then rules go straight to the edge record.
  async function withRules(siteId: string, rules: Rule[], status: 'active' | 'blocked' = 'active') {
    const site = await env.store.getSite(siteId);
    if (!site) throw new Error('no site');
    await syncEdge(env.edge, { ...site, rules, status });
  }

  it('serves public paths to anyone, keeps private folders private, and 404s missing public paths', async () => {
    const site = await publisher.publish(alice, {
      title: 'Mixed',
      content: { files: [...page('<h1>Public</h1>'), { path: 'notes/index.html', content: new TextEncoder().encode('secret notes') }] },
    });
    await withRules(site.site_id, [{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }]);

    const home = await get(site.site_id, '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('<h1>Public</h1>');
    expect(home.headers['content-security-policy']).toBe(contentSecurityPolicy(env.config.cdnAllowlist));
    expect((await get(site.site_id, '/missing.html')).status).toBe(404);

    // A private folder, whether or not the file exists, looks the same: sign in.
    for (const path of ['/notes/', '/notes/missing.html']) {
      const r = await get(site.site_id, path);
      expect(r.status, path).toBe(302);
      expect(String(r.headers.location), path).toContain('/site/signin');
    }
    expect((await get(site.site_id, '/notes/', { cookie: await signIn(site.site_id) })).body).toBe('secret notes');

    // Back to private: takes effect on the next request, with no invalidation (R40).
    await withRules(site.site_id, []);
    expect((await get(site.site_id, '/')).status).toBe(302);
  });

  it('serves nothing from a blocked site, whatever its rules (R41)', async () => {
    const site = await publisher.publish(alice, { title: 'Blocked', content: { files: page('x') } });
    await withRules(site.site_id, [{ path: '/', tier: 'public' }]);
    expect((await get(site.site_id, '/')).status).toBe(200);
    await withRules(site.site_id, [{ path: '/', tier: 'public' }], 'blocked');
    expect((await get(site.site_id, '/')).status).toBe(302);
  });
});
