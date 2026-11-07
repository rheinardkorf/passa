// The CLI against the whole local stack (Moto, auth, MCP, the proxy): a real
// sign-in through the browser, driven by a scripted browser, then tool calls.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Browser, type Stack, startStack } from '@passa/edge/testing';
import { addUser } from '@passa/mcp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessToken, LoginNeeded, login, logout, readCredentials } from './auth.ts';
import { request } from './http.ts';
import { callTool } from './mcp.ts';
import { addMember, deleteSite, listAccess, listMembers, listShares, parseRules, removeMember, publishFolder, rollback, setAccess, setName, share, syncFolder, unshare, waitUntilServed } from './deploy.ts';
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

describe('changing sites (R106–R110)', () => {
  // A folder of files, written fresh.
  const folderWith = (files: Record<string, string>) => {
    const folder = mkdtempSync(join(tmpdir(), 'passa-site-'));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), content);
    }
    return folder;
  };
  // Answers questions, and remembers them.
  const answering = (answer: boolean) => {
    const asked: string[] = [];
    return { asked, ask: (q: string) => Promise.resolve(void asked.push(q)).then(() => answer) };
  };

  it('publishes a folder privately, then syncs changes, asking before it removes anything', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ 'index.md': '# Home', 'about.md': '# About', 'old.md': '# Old', '.secret': 'never sent' });
    const published = await publishFolder(server, folder, 'From a folder', { dir, ask: answering(true).ask });
    expect(published).toMatchObject({ access: 'private', title: 'From a folder' });
    expect(readLink(folder)).toMatchObject({ site: published.site_id, version: published.current_version });
    await expect(publishFolder(server, folder, 'Again', { dir, ask: answering(true).ask })).rejects.toThrow(/already linked/);

    writeFileSync(join(folder, 'about.md'), '# About us');
    rmSync(join(folder, 'old.md'));
    const no = answering(false);
    await expect(syncFolder(await resolveTarget(folder, { dir }), { dir, ask: no.ask })).rejects.toThrow('Nothing was changed.');
    expect(no.asked[0]).toContain('old.md');

    const synced = await syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask });
    expect(synced).toMatchObject({ removed: 1 });
    expect(readLink(folder)?.version).toBe(synced.current_version);
    const files = (await callTool<{ files: { path: string }[] }>(server, 'get_site', { site_id: published.site_id, limit: 1 }, { dir })).files.map((f) => f.path);
    expect(files).toContain('about.md');
    expect(files).not.toContain('old.md');
    expect(files).not.toContain('.secret');
    expect((await syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask })).up_to_date).toBe(true);
  });

  it('refuses a sync with --base when the site moved on', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ 'index.md': '# Home' });
    const published = await publishFolder(server, folder, 'Moving', { dir, ask: answering(true).ask });
    await callTool(server, 'update', { site_id: published.site_id, files: [{ path: 'extra.md', content: '# Extra' }] }, { dir });
    writeFileSync(join(folder, 'index.md'), '# Home, edited');
    await expect(syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask, base: true })).rejects.toThrow(/has changed since this folder/);
  });

  it('makes a site public only once confirmed, then draws its cards locally so Passa draws none', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ '_site.yml': 'title: Local cards', 'index.md': '# Home', 'post.md': '---\ntitle: A post\n---\nHello.' });
    const published = await publishFolder(server, folder, 'Local cards', { dir, ask: answering(true).ask });
    const target = await resolveTarget(folder, { dir });

    const no = answering(false);
    await expect(setAccess(target, [{ path: '/', access: ['public'] }], { dir, ask: no.ask })).rejects.toThrow('Nothing was changed.');
    expect(no.asked[0]).toContain('This would make / public');
    const made = await setAccess(target, [{ path: '/', access: ['public'] }], { dir, ask: answering(true).ask });
    expect(made).toMatchObject({ access: 'public', made_public: ['/'] });

    // Set public by the access change, which re-rendered: the folder's next sync draws the cards.
    writeFileSync(join(folder, 'post.md'), '---\ntitle: A post, edited\n---\nHello.');
    const synced = await syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask });
    expect(synced.cards_drawn_locally).toBe(2);
    expect(synced).toMatchObject({ cards_stored: 1 }); // the home page's card was drawn by the access change
    expect(synced).not.toHaveProperty('cards_waiting');
    expect(synced).not.toHaveProperty('cards_skipped');
    expect((await syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask })).up_to_date).toBe(true);
    expect(published.site_id).toBe(target.siteId);
    // A public site says which version it serves, so sync can wait for it.
    expect(await waitUntilServed(synced.url, synced.current_version, { waitMs: 50 })).toBe('live');
  });

  it('has nothing to wait for on a private site, which doesn\'t say its version', async () => {
    const { dir } = await signedIn();
    const published = await publishFolder(server, folderWith({ 'index.md': '# Home' }), 'Private', { dir, ask: answering(true).ask });
    expect(await waitUntilServed(published.url, published.current_version, { waitMs: 50 })).toBe('unknown');
  });

  it('shares only once the email is confirmed, lists the share, and unshares (M5 R139)', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ 'index.html': '<p>home</p>', 'plans/index.html': '<p>plans</p>' });
    await publishFolder(server, folder, 'Sharing', { dir, ask: answering(true).ask });
    const target = await resolveTarget(folder, { dir });

    const no = answering(false);
    await expect(share(target, 'Sam@Example.com', { dir, ask: no.ask, path: '/plans/' })).rejects.toThrow('Nothing was shared.');
    expect(no.asked[0]).toContain('with sam@example.com?');
    expect((await listAccess(target, { dir })).shares).toEqual([]);

    const r = await share(target, 'sam@example.com', { dir, ask: answering(true).ask, path: '/plans/', expires: '2027-01-31' });
    expect(r).toMatchObject({ invite_sent: true, share: { email: 'sam@example.com', expires_at: '2027-01-31T23:59:59.000Z' } });
    expect(stack.sent.at(-1)?.to).toBe('sam@example.com');
    const listed = await listAccess(target, { dir });
    expect(listed).toMatchObject({ access: 'private', rules: [{ path: '/plans/', access: 'private' }], shares: [{ email: 'sam@example.com', path: '/plans/' }] });

    expect(await unshare(target, 'sam@example.com', { dir, path: '/plans/' })).toMatchObject({ unshared: 1, path: '/plans/' });
    expect((await listAccess(target, { dir })).shares).toEqual([]);
    expect(await setAccess(target, parseRules({ rule: ['/=gold,silver'] }) ?? [], { dir, ask: answering(false).ask })).toMatchObject({ access: 'members', rules: [{ path: '/', access: ['gold', 'silver'] }] });
  });

  it('adds members once the email is confirmed, lists them and shares across sites, and removes them (M6 R163)', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ 'index.html': '<p>home</p>', 'lessons/index.html': '<p>lessons</p>' });
    await publishFolder(server, folder, 'Course', { dir, ask: answering(true).ask });
    const target = await resolveTarget(folder, { dir });
    await setAccess(target, parseRules({ rule: ['/lessons/=gold'] }) ?? [], { dir, ask: answering(false).ask });

    const no = answering(false);
    await expect(addMember(target, 'Sam@Example.com', 'gold', { dir, ask: no.ask })).rejects.toThrow('Nobody was added.');
    expect(no.asked[0]).toContain('Add sam@example.com to gold');
    const r = await addMember(target, 'sam@example.com', 'gold', { dir, ask: answering(true).ask, for: '30d' });
    expect(r).toMatchObject({ invite_sent: true, member: { email: 'sam@example.com', tier: 'gold', expires_at: expect.any(String) } });
    expect(await listMembers(target, { dir })).toMatchObject({ tiers: ['gold'], members: [{ email: 'sam@example.com', last_used: 'never' }] });

    await share(target, 'kim@example.com', { dir, ask: answering(true).ask, path: '/lessons/', from: '2027-01-01' });
    const shares = await listShares(server, { dir, siteId: target.siteId });
    expect(shares).toMatchObject([{ email: 'kim@example.com', starts_at: '2027-01-01T00:00:00.000Z', expires_at: '2027-04-01T00:00:00.000Z' }]);

    expect(await removeMember(target, 'sam@example.com', { dir })).toMatchObject({ removed: 1 });
    expect((await listMembers(target, { dir })).members).toEqual([]);
  });

  it('names, rolls back and deletes', async () => {
    const { dir } = await signedIn();
    const folder = folderWith({ 'index.html': '<p>one</p>' });
    const published = await publishFolder(server, folder, 'Lifecycle', { dir, ask: answering(true).ask });
    writeFileSync(join(folder, 'index.html'), '<p>two</p>');
    await syncFolder(await resolveTarget(folder, { dir }), { dir, ask: answering(true).ask });
    const target = await resolveTarget(folder, { dir });

    const named = await setName(target, `life-${Date.now().toString(36)}`, { dir });
    expect(String(named.url)).toContain('life-');
    const back = await rollback(target, undefined, { dir, ask: answering(true).ask });
    expect(back.restored).toBe(published.current_version);
    expect(back.current_version).toBe(published.current_version); // plain HTML: the version itself
    expect(await deleteSite(target, true, { dir })).toMatchObject({ deleted: true });
    await expect(resolveTarget(published.site_id, { dir })).rejects.toThrow(/No site/);
  });
});
