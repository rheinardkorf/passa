// The CLI against the whole local stack (Moto, auth, MCP, the proxy): a real
// sign-in through the browser, driven by a scripted browser, then tool calls.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, type Stack, startStack } from '@passa/edge/testing';
import { addUser } from '@passa/mcp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessToken, LoginNeeded, login, logout, readCredentials } from './auth.ts';
import { request } from './http.ts';
import { callTool } from './mcp.ts';
import { pull, readLink, resolveTarget } from './sites.ts';

let stack: Stack;
let server: string;

beforeAll(async () => {
  stack = await startStack();
  server = `http://mcp.localhost:${stack.port}/mcp`;
});

afterAll(() => stack.close());

// What a person does in the browser: sign in by magic link, allow the CLI,
// and land back on the CLI's loopback redirect.
async function signInAs(email: string, url: string) {
  const issuer = `http://localhost:${stack.port}`;
  const browser = new Browser(stack.port);
  const signin = await browser.follow(url);
  const uid = /name="interaction" value="([^"]+)"/.exec(signin.body)?.[1] ?? '';
  await browser.open(`${issuer}/signin`, { email, interaction: uid });
  const token = /continue#t=([A-Za-z0-9_-]+)/.exec(stack.sent.at(-1)?.text ?? '')?.[1] ?? '';
  const consent = await browser.follow(`${issuer}/signin/continue`, { token });
  expect(consent.body).toContain('Passa CLI');
  const confirm = /action="(\/interaction\/[^"]+\/confirm)"/.exec(consent.body)?.[1] ?? '';
  const back = (await browser.follow(`${issuer}${confirm}`, {})).url;
  expect(back.hostname).toBe('127.0.0.1');
  await request(back.href);
}

// A new publisher each time, since sign-in emails are limited per address.
let users = 0;
const signedIn = async () => {
  const user = await addUser(stack.env, { id: `cli${++users}` });
  const dir = mkdtempSync(join(tmpdir(), 'passa-cli-auth-'));
  await login(server, { dir, open: (url) => signInAs(user.email, url) });
  return { dir, email: user.email };
};

describe('signing in (R99–R102)', () => {
  it('signs in through the browser and calls tools as the person who allowed it', async () => {
    const { dir } = await signedIn();
    const file = join(dir, 'credentials.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(readCredentials(dir).current).toBe(server);
    await callTool(server, 'publish', { title: 'From the CLI', files: [{ path: 'index.html', content: '<p>hi</p>' }] }, { dir });
    const found = await callTool<{ sites: { title: string }[] }>(server, 'find_sites', { query: 'From the CLI', limit: 5 }, { dir });
    expect(found.sites.map((s) => s.title)).toEqual(['From the CLI']);
  });

  it('registers once per server, and refreshes the access token with a rotating refresh token', async () => {
    const { dir, email } = await signedIn();
    const before = readCredentials(dir).servers[server];
    await login(server, { dir, open: (url) => signInAs(email, url) });
    expect(readCredentials(dir).servers[server]?.clientId).toBe(before?.clientId);

    const first = readCredentials(dir).servers[server];
    const token = await accessToken(server, { dir, force: true });
    const after = readCredentials(dir).servers[server];
    expect(token).not.toBe(first?.accessToken);
    expect(after?.refreshToken).not.toBe(first?.refreshToken);
    await callTool(server, 'find_sites', { limit: 1 }, { dir });
  });

  it('asks for a new sign-in once the refresh token is revoked', async () => {
    const { dir } = await signedIn();
    const saved = readCredentials(dir).servers[server];
    await request(saved?.revocationEndpoint ?? '', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: saved?.refreshToken ?? '', client_id: saved?.clientId ?? '' }).toString(),
    });
    await expect(accessToken(server, { dir, force: true })).rejects.toBeInstanceOf(LoginNeeded);
  });

  it('signs out by revoking at the server', async () => {
    const { dir } = await signedIn();
    const saved = readCredentials(dir).servers[server];
    expect(await logout(server, { dir })).toEqual({ revoked: true });
    expect(readCredentials(dir).servers[server]).toBeUndefined();
    // The revoked refresh token no longer works anywhere.
    const reply = await request(saved?.tokenEndpoint ?? '', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: saved?.refreshToken ?? '', client_id: saved?.clientId ?? '' }).toString(),
    });
    expect(reply.status).toBe(400);
  });

  it('refuses a token file other users can read', async () => {
    const { dir } = await signedIn();
    chmodSync(join(dir, 'credentials.json'), 0o644);
    expect(() => readCredentials(dir)).toThrow(/can be read by other users/);
  });
});

describe('reading sites (R103–R105)', () => {
  const files = [
    { path: 'index.md', content: '# Home\n\nSee [[Post]].' },
    { path: 'post.md', content: '---\ntitle: Post\n---\nHello.' },
    { path: 'logo.png', content: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', encoding: 'base64' },
  ];

  it('finds a site by ID, name or linked folder, and pulls its sources, not its rendered pages', async () => {
    const { dir } = await signedIn();
    const site = await callTool<{ site_id: string }>(server, 'publish', { title: 'Pull me', files }, { dir });
    await callTool(server, 'set_name', { site_id: site.site_id, name: 'pull-me' }, { dir });
    expect((await resolveTarget('pull-me', { dir })).siteId).toBe(site.site_id);
    expect((await resolveTarget(site.site_id, { dir })).siteId).toBe(site.site_id);
    await expect(resolveTarget('no-such-site', { dir })).rejects.toThrow(/No site no-such-site/);

    const folder = join(mkdtempSync(join(tmpdir(), 'passa-pull-')), 'site');
    const result = await pull(await resolveTarget('pull-me', { dir }), folder, { dir });
    expect(result.files).toBe(4); // two sources, the image, and the rules file
    expect(readFileSync(join(folder, 'post.md'), 'utf8')).toBe('---\ntitle: Post\n---\nHello.');
    expect(readFileSync(join(folder, 'logo.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(existsSync(join(folder, '_passa/access.yml'))).toBe(true);
    expect(existsSync(join(folder, 'post/index.html'))).toBe(false);
    expect(readLink(folder)).toEqual({ server, site: site.site_id, version: result.version });

    // The linked folder is the site from then on, and pulling again is fine.
    expect((await resolveTarget(folder, { dir })).siteId).toBe(site.site_id);
    await pull(await resolveTarget(folder, { dir }), folder, { dir });
  });

  it('refuses to pull into a folder with other files', async () => {
    const { dir } = await signedIn();
    const site = await callTool<{ site_id: string }>(server, 'publish', { title: 'Pull refused', files }, { dir });
    const folder = mkdtempSync(join(tmpdir(), 'passa-pull-'));
    mkdirSync(join(folder, 'notes'));
    writeFileSync(join(folder, 'notes/mine.md'), 'mine');
    await expect(pull(await resolveTarget(site.site_id, { dir }), folder, { dir })).rejects.toThrow(/has files and isn't linked/);
    expect(readFileSync(join(folder, 'notes/mine.md'), 'utf8')).toBe('mine');
  });
});
