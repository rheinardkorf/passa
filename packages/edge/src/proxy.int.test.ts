// Sites end to end: publish with the real tools into Moto, then browse through
// the local proxy, which runs the real edge handler, auth app and MCP endpoint.
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Publisher } from '@passa/mcp';
import { addUser, type TestEnv } from '@passa/mcp/testing';
import { contentSecurityPolicy, handoffUrl, type Rule, syncEdge } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, sendTo, type Stack, startStack } from './testing.ts';

let env: TestEnv;
let stack: Stack;
let port: number;
let publisher: Publisher;
let sent: { to: string; text: string }[] = [];
const key = { kid: 'k1', secret: 'c'.repeat(64) };
const alice = { userId: 'alice' };
const carol = { userId: 'carol' };

beforeAll(async () => {
  stack = await startStack();
  ({ env, port, publisher, sent } = stack);
  await addUser(env, { id: 'alice' });
  await addUser(env, { id: 'carol' });
  await env.edge.set('k:k1', key.secret);
});

afterAll(() => stack.close());

// Sends a request with a site's Host header to the proxy on 127.0.0.1.
const get = (siteId: string, path: string, headers: Record<string, string> = {}) => send(`${siteId}.localhost:${port}`, path, { headers });
const send = (host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => sendTo(port, host, path, init);

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
  const url = new URL(handoffUrl({ key, email: 'owner@example.com', tiers: 'o', siteId, accessVersion, origin: `http://${siteId}.localhost:${port}`, path: '/', cookieLifetime: 3600 }));
  const r = await get(siteId, url.pathname + url.search);
  expect(r.status).toBe(302);
  const set = (r.headers['set-cookie'] as string[])[0] ?? '';
  return set.slice(0, set.indexOf(';'));
}

// Opens the newest magic link sent to an email, as its owner would.
async function openLink(browser: Browser, to: string) {
  const link = /(http:\/\/localhost:\d+\/signin\/continue)#t=([A-Za-z0-9_-]+)/.exec(sent.filter((e) => e.to === to).at(-1)?.text ?? '');
  expect(link).not.toBeNull();
  await browser.open(link?.[1] ?? '');
  return browser.follow(link?.[1] ?? '', { token: link?.[2] ?? '' });
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
    const browser = new Browser(port);
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
    const browser = new Browser(port);
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
  it('takes a visitor from a named site\'s ID address to its name, and signs them in there (M2 R45)', async () => {
    const site = await publisher.publish(alice, { title: 'Named', content: { files: page('<h1>By name</h1>') } });
    const named = await publisher.setName(alice, { siteId: site.site_id, name: 'by-name' });
    expect(named.url).toBe(`http://by-name.localhost:${port}/`);
    const browser = new Browser(port);

    const fromId = await browser.open(`${site.url}docs/`);
    expect([fromId.status, fromId.headers.location]).toEqual([302, `http://by-name.localhost:${port}/docs/`]);
    const atName = await browser.open(String(fromId.headers.location));
    expect(atName.headers.location).toBe(`http://localhost:${port}/site/signin?site=by-name&path=%2Fdocs%2F`);
    const form = await browser.open(String(atName.headers.location));
    expect(form.body).toContain('value="by-name"');

    await browser.open(`http://localhost:${port}/signin`, { email: 'alice@example.com', site: 'by-name', path: '/' });
    const link = /(http:\/\/localhost:\d+\/signin\/continue)#t=([A-Za-z0-9_-]+)/.exec(sent.at(-1)?.text ?? '');
    const continued = await browser.open(link?.[1] ?? '', { token: link?.[2] ?? '' });
    const next = (/content="0;url=([^"]+)"/.exec(continued.body)?.[1] ?? '').replaceAll('&amp;', '&');
    const handoff = await browser.open(new URL(next, continued.url).href);
    // Handed back to the name, as the database says, not to the ID.
    expect(new URL(String(handoff.headers.location)).host).toBe(`by-name.localhost:${port}`);
    await browser.open(String(handoff.headers.location));
    const pageReply = await browser.open(named.url);
    expect([pageReply.status, pageReply.body.includes('<h1>By name</h1>')]).toEqual([200, true]);
  });

  it('treats an unknown name exactly like a private site', async () => {
    const browser = new Browser(port);
    const unknown = await browser.open(`http://no-such-name.localhost:${port}/`);
    expect(unknown.headers.location).toBe(`http://localhost:${port}/site/signin?site=no-such-name&path=%2F`);
    expect((await browser.open(String(unknown.headers.location))).body).toContain('Enter your email');
  });
});

describe('sharing (M5)', () => {
  // Follows a magic link the way the page's script does, then the handoff.
  it('lets someone a site is shared with sign in and open its shared paths, until unshared (R128–R136)', async () => {
    const site = await publisher.publish(alice, { title: 'Plans', content: { files: [...page('<h1>Home</h1>'), { path: 'plans/index.html', content: new TextEncoder().encode('<h1>Plans</h1>') }] } });
    const shared = await publisher.share(alice, { siteId: site.site_id, email: 'sam@example.com', path: '/plans/', confirmShare: true });
    expect(shared.invite_sent).toBe(true);
    const invite = sent.at(-1);
    expect(invite?.to).toBe('sam@example.com');
    expect(invite?.text).toContain(`${site.url}plans/`);

    // From the invite: sign in with the email it went to.
    const browser = new Browser(port);
    const start = await browser.follow(`${site.url}plans/`);
    expect(start.body).toContain('Enter your email');
    await browser.open(`http://localhost:${port}/signin`, { email: 'sam@example.com', site: site.site_id, path: '/plans/' });
    const landed = await openLink(browser, 'sam@example.com');
    expect(landed.status).toBe(200);
    expect(landed.body).toContain('<h1>Plans</h1>');

    // The private root is refused, without a loop, and a viewer can't publish.
    const root = await browser.follow(site.url);
    expect(root.status).toBe(403);
    expect(root.body).toContain('doesn\'t have access to this page');
    const viewer = await env.store.findUserByEmail('sam@example.com');
    expect(viewer?.roles).toEqual([]);
    await expect(publisher.assertPublisher({ userId: viewer?.id ?? '' })).rejects.toThrow('This account cannot publish.');

    // Unshared: the next request goes back to auth., which refuses it.
    await publisher.unshare(alice, { siteId: site.site_id, email: 'sam@example.com' });
    const after = await browser.follow(`${site.url}plans/`);
    expect(after.status).toBe(403);
  });

  it('shows each person only the paths shared with them (proposals for different clients)', async () => {
    const file = (path: string, body: string) => ({ path, content: new TextEncoder().encode(`<h1>${body}</h1>`) });
    const site = await publisher.publish(alice, { title: 'Proposals', content: { files: [...page('<h1>Home</h1>'), file('proposals/acme/index.html', 'Acme'), file('proposals/globex/index.html', 'Globex')] } });
    await publisher.share(alice, { siteId: site.site_id, email: 'acme@example.com', path: '/proposals/acme/', confirmShare: true });
    await publisher.share(alice, { siteId: site.site_id, email: 'globex@example.com', path: '/proposals/globex/', confirmShare: true });
    // The folder above both: a share stops at the next rule down (M6 R156), so it opens neither proposal, and says so.
    const above = await publisher.share(alice, { siteId: site.site_id, email: 'partner@example.com', path: '/proposals/', confirmShare: true });
    expect(above.left_out).toEqual([`${site.url}proposals/acme/`, `${site.url}proposals/globex/`]);

    const signedIn = async (email: string, path: string) => {
      const browser = new Browser(port);
      await browser.follow(`${site.url}${path.slice(1)}`);
      await browser.open(`http://localhost:${port}/signin`, { email, site: site.site_id, path });
      const landed = await openLink(browser, email);
      return { browser, landed };
    };
    const acme = await signedIn('acme@example.com', '/proposals/acme/');
    expect(acme.landed.body).toContain('<h1>Acme</h1>');
    expect((await acme.browser.follow(`${site.url}proposals/globex/`)).status).toBe(403);
    expect((await acme.browser.follow(site.url)).status).toBe(403);

    const globex = await signedIn('globex@example.com', '/proposals/globex/');
    expect(globex.landed.body).toContain('<h1>Globex</h1>');
    expect((await globex.browser.follow(`${site.url}proposals/acme/`)).status).toBe(403);

    // A share of the folder opens both shared folders under it.
    const partner = await signedIn('partner@example.com', '/proposals/acme/');
    expect(partner.landed.status).toBe(403);
    // Shared Acme's folder itself, they open it, and still not Globex's.
    await publisher.unshare(alice, { siteId: site.site_id, email: 'partner@example.com', path: '/proposals/' });
    await publisher.share(alice, { siteId: site.site_id, email: 'partner@example.com', path: '/proposals/acme/', confirmShare: true });
    expect((await partner.browser.follow(`${site.url}proposals/acme/`)).body).toContain('<h1>Acme</h1>');
    expect((await partner.browser.follow(`${site.url}proposals/globex/`)).status).toBe(403);
  });

  it('lets members open their tiers\' paths within their dates, until removed (M6 R153–R158, R166)', async () => {
    const file = (path: string, body: string) => ({ path, content: new TextEncoder().encode(`<h1>${body}</h1>`) });
    const site = await publisher.publish(carol, {
      title: 'Course',
      content: { files: [...page('<h1>Home</h1>'), file('lessons/index.html', 'Lessons'), file('lessons/bonus/index.html', 'Bonus')] },
      rules: [{ path: '/', access: ['public'] }, { path: '/lessons/', access: ['gold', 'silver'] }, { path: '/lessons/bonus/', access: ['gold'] }],
      confirmPublic: true,
    });
    const added = await publisher.addMember(carol, { siteId: site.site_id, email: 'Sam@example.com', tier: 'silver', confirmMember: true });
    expect(added.tier_urls).toEqual([`${site.url}lessons/`]);
    expect(sent.at(-1)?.text).toContain('added you as a member of a site');
    expect(sent.at(-1)?.text).not.toContain('silver');
    // Starts tomorrow: opens nothing yet, so no sign-in link.
    await publisher.addMember(carol, { siteId: site.site_id, email: 'kim@example.com', tier: 'gold', startsAt: new Date(Date.now() + 86_400_000).toISOString(), confirmMember: true });

    const signedIn = async (email: string, path: string) => {
      const browser = new Browser(port);
      await browser.follow(`${site.url}${path.slice(1)}`);
      const before = sent.length;
      await browser.open(`http://localhost:${port}/signin`, { email, site: site.site_id, path });
      return { browser, linked: sent.length > before };
    };
    const sam = await signedIn('sam@example.com', '/lessons/');
    expect(sam.linked).toBe(true);
    expect((await openLink(sam.browser, 'sam@example.com')).body).toContain('<h1>Lessons</h1>');
    expect((await sam.browser.follow(`${site.url}lessons/bonus/`)).status).toBe(403);
    expect((await env.store.getMembership(site.site_id, 'sam@example.com', 'silver'))?.lastUsedAt).toBe(new Date().toISOString().slice(0, 10));
    expect((await signedIn('kim@example.com', '/lessons/')).linked).toBe(false);

    // Removed: the next request goes back to auth., which refuses it.
    await publisher.removeMember(carol, { siteId: site.site_id, email: 'sam@example.com' });
    expect((await sam.browser.follow(`${site.url}lessons/`)).status).toBe(403);
  });

  it('sends no sign-in link to an email a site isn\'t shared with, answering the same (R135)', async () => {
    const site = await publisher.publish(alice, { title: 'Not shared', content: { files: page('x') } });
    const browser = new Browser(port);
    await browser.follow(site.url);
    const before = sent.length;
    const r = await browser.open(`http://localhost:${port}/signin`, { email: 'stranger@example.com', site: site.site_id, path: '/' });
    expect(r.status).toBeLessThan(400);
    expect(sent.length).toBe(before);
    expect(await env.store.findUserByEmail('stranger@example.com')).toBeUndefined();
  });
});

describe('fragments (M7)', () => {
  it('serves HTMX, answers a refused fragment request with a 204, and never lets a fragment be indexed', async () => {
    const text = (path: string, body: string) => ({ path, content: new TextEncoder().encode(body) });
    const site = await publisher.publish(alice, {
      title: 'Home',
      content: { files: [
        text('_site.yml', 'title: Home\ntiers: [family]\naccess:\n  /: [public]\n  /family/: [family]\n'),
        text('index.md', '# Home\n\n```fragment\nsrc: [[family/cards]]\nclass: cards\n```\n'),
        text('family/cards.md', '---\nfragment: true\n---\n- [Anna](https://anna.example.com/)\n'),
      ] },
      confirmPublic: true,
    });
    await publisher.setName(alice, { siteId: site.site_id, name: 'the-family' });

    const home = await get('the-family', '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('<div class="passa-embed cards" hx-get="/family/cards/"');
    const htmx = /<script src="(\/_passa\/htmx-[\d.]+\.min\.js)"><\/script>/.exec(home.body)?.[1] ?? '';
    const script = await get('the-family', htmx);
    expect([script.status, script.headers['content-type'], script.headers['cache-control']]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    expect(script.body).toContain('htmx');

    // A stranger's HTMX request: nothing, not sign-in. Without the header, sign-in.
    const refused = await get('the-family', '/family/cards/', { 'hx-request': 'true' });
    expect([refused.status, refused.body, refused.headers['cache-control'], refused.headers.location]).toEqual([204, '', 'no-store', undefined]);
    expect((await get('the-family', '/family/cards/')).status).toBe(302);

    // Someone it opens to gets the fragment, never indexed, even on a name host.
    const cards = await get('the-family', '/family/cards/', { 'hx-request': 'true', cookie: await signIn(site.site_id) });
    expect(cards.status).toBe(200);
    expect(cards.body).toMatch(/^<div class="passa-fragment">/);
    expect(cards.headers['x-robots-tag']).toBe('noindex');
    expect(Object.keys(cards.headers).filter((h) => h.startsWith('x-amz-meta'))).toEqual([]);
    expect((await get('the-family', '/')).headers['x-robots-tag']).toBeUndefined();
  });
});

describe('signing in from a page (M7)', () => {
  it('shows who is signed in, refreshes a stale cookie through auth., and clears it when access is gone', async () => {
    const text = (path: string, body: string) => ({ path, content: new TextEncoder().encode(body) });
    const site = await publisher.publish(carol, {
      title: 'Home',
      content: { files: [
        text('_site.yml', 'title: Home\ntiers: [family]\naccess:\n  /: [public]\n  /family/: [family]\n'),
        text('index.md', '# Home\n\n```login\nshow_user: true\n```\n\n```fragment\nsrc: [[family/cards]]\n```\n'),
        text('family/cards.md', '---\nfragment: true\n---\nThe cards\n'),
      ] },
      confirmPublic: true,
    });
    await publisher.addMember(carol, { siteId: site.site_id, email: 'anna@example.com', tier: 'family', confirmMember: true });
    const home = await get(site.site_id, '/');
    expect(home.body).toContain('href="/_passa/signin?path=%2F"');

    // From the page's link, through auth.'s sign-in, back to the page with a cookie.
    const anna = new Browser(port);
    const link = await anna.follow(`${site.url}_passa/signin?path=%2F`);
    expect(link.url.pathname).toBe('/site/signin');
    await anna.open(`http://localhost:${port}/signin`, { email: 'anna@example.com', site: site.site_id, path: '/' });
    expect((await openLink(anna, 'anna@example.com')).url.href).toBe(site.url);
    const hx = { 'hx-request': 'true', 'hx-current-url': site.url };
    const who = await anna.open(`${site.url}_passa/login?show_user=true`, undefined, hx);
    expect(who.body).toBe('<span class="passa-login-who">Signed in as anna@example.com</span>');
    expect((await anna.open(`${site.url}family/cards/`, undefined, hx)).status).toBe(200);

    // Added again (new dates), the access version moves on: the fragment's
    // request goes through auth.'s refresh and back, with no email.
    await publisher.addMember(carol, { siteId: site.site_id, email: 'anna@example.com', tier: 'family', confirmMember: true });
    const emails = sent.length;
    const stale = await anna.open(`${site.url}family/cards/`, undefined, hx);
    expect([stale.status, stale.body]).toEqual([204, '']);
    const refresh = String(stale.headers['hx-redirect']);
    expect(refresh).toBe(`http://localhost:${port}/site/refresh?site=${site.site_id}&path=%2F`);
    expect((await anna.follow(refresh)).url.href).toBe(site.url);
    expect((await anna.open(`${site.url}family/cards/`, undefined, hx)).body).toContain('The cards');
    expect(sent.length).toBe(emails);

    // Removed: the refresh clears the cookie, and the next request is a stranger's.
    await publisher.removeMember(carol, { siteId: site.site_id, email: 'anna@example.com' });
    const gone = await anna.open(`${site.url}family/cards/`, undefined, hx);
    expect(gone.headers['hx-redirect']).toBe(refresh);
    expect((await anna.follow(refresh)).url.href).toBe(site.url);
    const after = await anna.open(`${site.url}family/cards/`, undefined, hx);
    expect([after.status, after.headers['hx-redirect']]).toEqual([204, undefined]);
    expect((await anna.open(`${site.url}_passa/login?show_user=true`, undefined, hx)).status).toBe(204);
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
      httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { host: `calm-heron-bcdfgh.localhost:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
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

  it('lets search engines index a named site\'s public pages, but not an unnamed site\'s (M2 R42)', async () => {
    const site = await publisher.publish(alice, { title: 'Indexed', content: { files: page('<h1>Find me</h1>') } });
    await publisher.setAccess(alice, { siteId: site.site_id, rules: [{ path: '/', access: ['public'] }], confirmPublic: true });
    const byId = await get(site.site_id, '/');
    expect([byId.status, byId.headers['x-robots-tag']]).toEqual([200, 'noindex']);
    await publisher.setName(alice, { siteId: site.site_id, name: 'find-me' });
    const byName = await get('find-me', '/');
    expect([byName.status, byName.headers['x-robots-tag']]).toEqual([200, undefined]);
    // The ID address only redirects now, and says not to index the redirect.
    const redirect = await get(site.site_id, '/');
    expect([redirect.status, redirect.headers['x-robots-tag']]).toEqual([302, 'noindex']);
  });

  it('serves public paths to anyone, keeps private folders private, and 404s missing public paths', async () => {
    const site = await publisher.publish(alice, {
      title: 'Mixed',
      content: { files: [...page('<h1>Public</h1>'), { path: 'notes/index.html', content: new TextEncoder().encode('secret notes') }] },
    });
    await withRules(site.site_id, [{ path: '/', access: ['public'] }, { path: '/notes/', access: 'private' }]);

    const home = await get(site.site_id, '/');
    expect(home.status).toBe(200);
    expect(home.body).toContain('<h1>Public</h1>');
    expect(home.headers['content-security-policy']).toBe(contentSecurityPolicy(env.config.cdnAllowlist));
    expect(home.headers['x-robots-tag']).toBe('noindex');
    // Other sites may embed public files (for link previews), not private ones.
    expect(home.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect((await get(site.site_id, '/missing.html')).status).toBe(404);

    // A private folder, whether or not the file exists, looks the same: sign in.
    for (const path of ['/notes/', '/notes/missing.html']) {
      const r = await get(site.site_id, path);
      expect(r.status, path).toBe(302);
      expect(String(r.headers.location), path).toContain('/site/signin');
    }
    const notes = await get(site.site_id, '/notes/', { cookie: await signIn(site.site_id) });
    expect([notes.body, notes.headers['cross-origin-resource-policy']]).toEqual(['secret notes', 'same-origin']);

    // Back to private: takes effect on the next request, with no invalidation (R40).
    await withRules(site.site_id, []);
    expect((await get(site.site_id, '/')).status).toBe(302);
  });

  it('serves nothing from a blocked site, whatever its rules (R41)', async () => {
    const site = await publisher.publish(alice, { title: 'Blocked', content: { files: page('x') } });
    await withRules(site.site_id, [{ path: '/', access: ['public'] }]);
    expect((await get(site.site_id, '/')).status).toBe(200);
    await withRules(site.site_id, [{ path: '/', access: ['public'] }], 'blocked');
    expect((await get(site.site_id, '/')).status).toBe(302);
  });
});
