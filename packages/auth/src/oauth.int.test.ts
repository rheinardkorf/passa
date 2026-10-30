// The OAuth flow an MCP client goes through, against Moto: registration, the
// authorization request, Passa sign-in, consent, tokens signed in KMS (Moto's),
// refresh, revocation, and the connected-apps page.
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import { addUser, type TestEnv, testEnv } from '@passa/mcp/testing';
import { loadTokenKey, type User } from '@passa/shared';
import { importSPKI, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from './app.ts';
import { allowClientIdUrl, loopbackMatches } from './oauth.ts';
import { type AuthTestDeps, authTestDeps } from './testing.ts';

const AUTH = 'https://auth.example.com';
const RESOURCE = 'https://mcp.example.com/mcp';

let env: TestEnv;
let deps: AuthTestDeps;
let server: Server;
let base: string;

beforeAll(async () => {
  env = await testEnv();
  deps = { ...(await authTestDeps(env, { auth: AUTH, mcp: 'https://mcp.example.com', site: (id) => `https://${id}.example.com` })), trustProxy: true };
  server = await new Promise<Server>((resolve) => {
    const s = createAuthApp(deps).listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// What CloudFront passes on: the public host and scheme.
const PROXIED = { 'x-forwarded-host': 'auth.example.com', 'x-forwarded-proto': 'https' };
const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...PROXIED, ...(init.headers as Record<string, string>) } });

type Reply = { status: number; location: string; body: string };

// A browser: keeps cookies, posts forms with the Origin and CSRF token.
class Browser {
  cookies = new Map<string, string>();

  async go(url: string, form?: Record<string, string>): Promise<Reply> {
    const parsed = new URL(url, AUTH);
    const path = parsed.origin === AUTH ? parsed.pathname + parsed.search : url;
    const headers: Record<string, string> = { ...PROXIED, cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body: string | undefined;
    if (form) {
      headers.origin = AUTH;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ csrf: this.cookies.get('__Host-passa-csrf') ?? '', ...form }).toString();
    }
    const res = await fetch(`${base}${path}`, { method: form ? 'POST' : 'GET', headers, redirect: 'manual', ...(body ? { body } : {}) });
    for (const c of res.headers.getSetCookie()) {
      const pair = c.slice(0, c.indexOf(';'));
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(c) || /Max-Age=0\b/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text() };
  }

  // Follows redirects and continuing pages until leaving auth. or reaching a page.
  async follow(url: string, form?: Record<string, string>): Promise<Reply & { url: string }> {
    let reply = await this.go(url, form);
    let at = url;
    for (let i = 0; i < 10; i++) {
      const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(reply.body)?.[1]?.replaceAll('&amp;', '&');
      const next = reply.status >= 300 && reply.status < 400 ? reply.location : refresh;
      if (!next) break;
      at = new URL(next, `${AUTH}${at.startsWith('/') ? at : ''}`).href;
      if (new URL(at).origin !== AUTH) break;
      reply = await this.go(at);
    }
    return { ...reply, url: at };
  }
}

type Client = { client_id: string; redirect: string };

async function register(name = 'Test Agent'): Promise<Client> {
  const res = await call('/reg', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ['http://127.0.0.1/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(res.status).toBe(201);
  const { client_id } = (await res.json()) as { client_id: string };
  return { client_id, redirect: 'http://127.0.0.1:43123/callback' };
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function authorizeUrl(client: Client, challenge: string, extra: Record<string, string> = {}): string {
  return `/auth?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: client.redirect,
    response_type: 'code',
    scope: 'publish offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: RESOURCE,
    state: 'st',
    prompt: 'consent',
    ...extra,
  })}`;
}

async function newPublisher(roles: User['roles'] = ['publisher']): Promise<User> {
  const id = `u${randomBytes(4).toString('hex')}`;
  return addUser(env, { id, email: `${id}@example.com`, roles });
}

const tokenFor = (email: string) => /continue#t=([A-Za-z0-9_-]{43})/.exec(deps.sent.filter((e) => e.to === email).at(-1)?.text ?? '')?.[1] ?? '';

// Runs the whole authorization as a publisher, returning the code.
async function authorize(browser: Browser, client: Client, user: User, challenge: string): Promise<URL> {
  const signin = await browser.follow(authorizeUrl(client, challenge));
  if (signin.body.includes('An app wants to publish as you')) {
    const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
    await browser.go('/signin', { email: user.email, interaction: uid });
    const consent = await browser.follow('/signin/continue', { token: tokenFor(user.email) });
    expect(consent.body).toContain('Connect an app?');
    return confirm(browser, consent.body);
  }
  return confirm(browser, signin.body);
}

async function confirm(browser: Browser, consentBody: string): Promise<URL> {
  const action = /action="(\/interaction\/[^/]+\/confirm)"/.exec(consentBody)?.[1] ?? '';
  const done = await browser.follow(action, {});
  return new URL(done.url);
}

async function exchange(client: Client, code: string, verifier: string) {
  const res = await call('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: client.redirect, client_id: client.client_id, resource: RESOURCE }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function refresh(client: Client, refreshToken: string) {
  const res = await call('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.client_id, resource: RESOURCE }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function verify(accessToken: string) {
  const { kid, publicKey } = await loadTokenKey(deps.kms, deps.tokenKeyId);
  const key = await importSPKI(publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'ES256');
  const { payload, protectedHeader } = await jwtVerify(accessToken, key, { issuer: AUTH, audience: RESOURCE, typ: 'at+jwt' });
  return { payload, protectedHeader, kid };
}

describe('metadata (R21)', () => {
  it('is served at the RFC 8414 path, with S256 PKCE and both registration methods', async () => {
    const meta = (await (await call('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>;
    expect(meta.issuer).toBe(AUTH);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toBe(`${AUTH}/reg`);
    expect(meta.client_id_metadata_document_supported).toBe(true);
    expect(meta.scopes_supported).toContain('publish');
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.grant_types_supported).not.toContain('implicit');
  });
});

describe('connecting an app', () => {
  it('signs a publisher in by magic link, asks consent, and issues KMS-signed tokens for the MCP server (R23, R24, R26)', async () => {
    const user = await newPublisher();
    const client = await register('Claude Test');
    const browser = new Browser();
    const { verifier, challenge } = pkce();

    const signin = await browser.follow(authorizeUrl(client, challenge));
    expect(signin.body).toContain('An app wants to publish as you');
    const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
    await browser.go('/signin', { email: user.email, interaction: uid });
    const consent = await browser.follow('/signin/continue', { token: tokenFor(user.email) });
    expect(consent.body).toContain('Claude Test');
    expect(consent.body).toContain(client.client_id);
    expect(consent.body).toContain('<p class="host">127.0.0.1:43123</p>');

    const back = await confirm(browser, consent.body);
    expect(`${back.origin}${back.pathname}`).toBe('http://127.0.0.1:43123/callback');
    expect(back.searchParams.get('state')).toBe('st');
    const tokens = await exchange(client, back.searchParams.get('code') ?? '', verifier);
    expect(tokens.status).toBe(200);
    expect(tokens.body.refresh_token).toBeTruthy();

    const { payload, protectedHeader, kid } = await verify(tokens.body.access_token ?? '');
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid, typ: 'at+jwt' });
    expect(payload).toMatchObject({ sub: user.id, aud: RESOURCE, scope: 'publish', client_id: client.client_id });
    expect(await deps.oidc.grantActive(String(payload.gid))).toBe(true);
  });

  it('skips the email and, once granted, consent too, while the session lasts', async () => {
    const user = await newPublisher();
    const client = await register();
    const browser = new Browser();
    await authorize(browser, client, user, pkce().challenge);
    const sentBefore = deps.sent.length;
    const { verifier, challenge } = pkce();
    const again = await browser.follow(authorizeUrl(client, challenge, { prompt: '' }).replace('&prompt=', ''));
    const back = new URL(again.url);
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(deps.sent.length).toBe(sentBefore);
    expect((await exchange(client, back.searchParams.get('code') ?? '', verifier)).status).toBe(200);
  });

  it('asks for a Passa sign-in again after signing out', async () => {
    const user = await newPublisher();
    const client = await register();
    const browser = new Browser();
    await authorize(browser, client, user, pkce().challenge);
    await browser.go('/signout', {});
    const again = await browser.follow(authorizeUrl(client, pkce().challenge));
    expect(again.body).toContain('An app wants to publish as you');
  });

  it('refuses people who can sign in but not publish, before consent (R24)', async () => {
    const viewer = await newPublisher([]);
    const client = await register();
    const browser = new Browser();
    // No email for an app sign-in: they can't publish.
    const signin = await browser.follow(authorizeUrl(client, pkce().challenge));
    const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
    await browser.go('/signin', { email: viewer.email, interaction: uid });
    expect(deps.sent.filter((e) => e.to === viewer.email)).toHaveLength(0);

    // Signed in some other way, they're turned away with no consent screen.
    await browser.go('/signin', { email: viewer.email });
    await browser.follow('/signin/continue', { token: tokenFor(viewer.email) });
    const refused = await browser.follow(authorizeUrl(client, pkce().challenge));
    expect(refused.status).toBe(403);
    expect(refused.body).toContain("can't publish");
    expect(refused.body).not.toContain('Allow');
    const back = /href="([^"]+)">Back to the app/.exec(refused.body)?.[1]?.replaceAll('&amp;', '&') ?? '';
    const result = await browser.follow(back);
    expect(new URL(result.url).searchParams.get('error')).toBe('access_denied');
  });

  it('returns access_denied when the publisher denies', async () => {
    const user = await newPublisher();
    const client = await register();
    const browser = new Browser();
    const signin = await browser.follow(authorizeUrl(client, pkce().challenge));
    const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
    await browser.go('/signin', { email: user.email, interaction: uid });
    const consent = await browser.follow('/signin/continue', { token: tokenFor(user.email) });
    const action = /action="(\/interaction\/[^/]+\/deny)"/.exec(consent.body)?.[1] ?? '';
    const back = new URL((await browser.follow(action, {})).url);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });
});

describe('authorization requests', () => {
  it('require PKCE with S256 and the MCP server as the resource (R23)', async () => {
    const client = await register();
    const browser = new Browser();
    const { challenge } = pkce();
    const cases = [
      authorizeUrl(client, challenge, { code_challenge_method: 'plain' }),
      authorizeUrl(client, challenge).replace(/&code_challenge=[^&]+/, ''),
      authorizeUrl(client, challenge, { resource: 'https://evil.example/mcp' }),
    ];
    for (const url of cases) {
      const r = await browser.go(url);
      const error = new URL(r.location || 'x:', 'http://x').searchParams.get('error');
      expect(r.status === 400 || error !== null, url).toBe(true);
    }
  });

  it('match loopback redirects on any port, and nothing else loosely (R25)', async () => {
    const client = await register();
    const browser = new Browser();
    const ok = await browser.go(authorizeUrl({ ...client, redirect: 'http://127.0.0.1:5999/callback' }, pkce().challenge));
    expect(ok.status).toBe(303);
    for (const redirect of ['http://127.0.0.1:5999/other', 'http://localhost:5999/callback', 'https://127.0.0.1/callback', 'http://evil.example/callback']) {
      expect((await browser.go(authorizeUrl({ ...client, redirect }, pkce().challenge))).status, redirect).toBe(400);
    }
    expect(loopbackMatches(['http://localhost/callback'], 'http://localhost:8123/callback')).toBe(true);
    expect(loopbackMatches(['http://localhost/callback'], 'http://localhost.evil.example:8123/callback')).toBe(false);
  });

  it('only fetch client metadata documents from public hostnames (R28)', () => {
    expect(allowClientIdUrl('https://claude.ai/oauth/claude-code-client-metadata')).toBe(true);
    for (const id of ['https://127.0.0.1/x', 'https://[::1]/x', 'https://10.0.0.1/x', 'https://localhost/x', 'https://metadata.internal/x', 'https://printer.local/x', 'https://intranet/x']) {
      expect(allowClientIdUrl(id), id).toBe(false);
    }
  });
});

describe('tokens', () => {
  it('rotate refresh tokens, and reusing one revokes the whole grant (R27)', async () => {
    const user = await newPublisher();
    const client = await register();
    const { verifier, challenge } = pkce();
    const back = await authorize(new Browser(), client, user, challenge);
    const first = await exchange(client, back.searchParams.get('code') ?? '', verifier);
    const second = await refresh(client, first.body.refresh_token ?? '');
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    const { payload } = await verify(second.body.access_token ?? '');

    const reused = await refresh(client, first.body.refresh_token ?? '');
    expect(reused.body.error).toBe('invalid_grant');
    expect(await deps.oidc.grantActive(String(payload.gid))).toBe(false);
    expect((await refresh(client, second.body.refresh_token ?? '')).body.error).toBe('invalid_grant');
  });

  it('stop refreshing once the user is no longer a publisher', async () => {
    const user = await newPublisher();
    const client = await register();
    const { verifier, challenge } = pkce();
    const back = await authorize(new Browser(), client, user, challenge);
    const first = await exchange(client, back.searchParams.get('code') ?? '', verifier);
    await env.store.putUser({ ...user, status: 'disabled' });
    expect((await refresh(client, first.body.refresh_token ?? '')).status).toBe(400);
  });
});

describe('connected apps (R29)', () => {
  it('lists the publisher’s apps and disconnects one at once', async () => {
    const user = await newPublisher();
    const client = await register('Disconnect Me');
    const browser = new Browser();
    const { verifier, challenge } = pkce();
    const back = await authorize(browser, client, user, challenge);
    const tokens = await exchange(client, back.searchParams.get('code') ?? '', verifier);
    const { payload } = await verify(tokens.body.access_token ?? '');

    const page = await browser.go('/apps');
    expect(page.body).toContain('Disconnect Me');
    const grant = /name="grant" value="([^"]+)"/.exec(page.body)?.[1] ?? '';
    expect(grant).toBe(payload.gid);

    // Someone else can't disconnect it.
    const other = new Browser();
    const stranger = await newPublisher();
    await other.go('/signin', { email: stranger.email });
    await other.follow('/signin/continue', { token: tokenFor(stranger.email) });
    await other.go('/apps/revoke', { grant });
    expect(await deps.oidc.grantActive(grant)).toBe(true);

    await browser.go('/apps/revoke', { grant });
    expect(await deps.oidc.grantActive(grant)).toBe(false);
    expect((await refresh(client, tokens.body.refresh_token ?? '')).body.error).toBe('invalid_grant');
    expect((await browser.go('/apps')).body).toContain('No apps are connected');
  });
});
