// The publishing tools end to end: an MCP client calls the server in memory,
// and the server stores into Moto.
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newVersionId, NotFoundOrConflict } from '@passa/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { Publisher } from './publisher.ts';
import { createServer } from './server.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
const logs: unknown[] = [];

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  await addUser(env, { id: 'bob' });
  await addUser(env, { id: 'carol', status: 'disabled' });
  await addUser(env, { id: 'dave', roles: ['admin'] });
});

type Result = { isError?: boolean; text: string; json: () => Record<string, unknown> };

async function as(userId: string, now?: Date) {
  const server = createServer({ ...env, ...(now ? { now: () => now } : {}) }, { userId, ip: '203.0.113.7' }, (msg, data) => logs.push({ msg, ...data }));
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
}

const page = (body: string) => [{ path: 'index.html', content: `<!doctype html><title>t</title>${body}` }];
const sha256 = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

type SiteFile = { path: string; size: number; content_type: string; sha256: string; content?: string; download_url?: string };

// Every file's contents, by path: listed by get_site, then read with get_files.
async function contents(call: Awaited<ReturnType<typeof as>>, siteId: unknown, versionId?: unknown): Promise<Record<string, string | undefined>> {
  const version = versionId ? { version_id: versionId } : {};
  const listed = (await call('get_site', { site_id: siteId, ...version })).json().files as SiteFile[];
  const got = (await call('get_files', { site_id: siteId, ...version, paths: listed.map((f) => f.path) })).json().files as SiteFile[];
  return Object.fromEntries(got.map((f) => [f.path, f.content]));
}

async function eventsFor(userId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const { Items } = await env.db.send(new QueryCommand({ TableName: env.tables.events, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `DAY#${day}` } }));
  return (Items ?? []).filter((e) => e.userId === userId);
}

describe('publish, update and rollback', () => {
  it('publishes a private site and returns its URL (R1)', async () => {
    const call = await as('alice');
    const r = await call('publish', { files: page('<h1>One</h1>'), title: 'Quarterly numbers', data_source: 'Finance sheet', data_as_of: '2026-10-01T00:00:00Z' });
    expect(r.isError).toBe(false);
    const site = r.json();
    expect(site.url).toMatch(/^https:\/\/[a-z]{3,6}-[a-z]{3,6}-[a-z2-9]{6}\.example\.com\/$/);
    expect(site).toMatchObject({ title: 'Quarterly numbers', status: 'active', data_source: 'Finance sheet', files: 1 });

    // Stored under an immutable version prefix (R13).
    const object = await env.s3.send(new GetObjectCommand({ Bucket: env.buckets.sites, Key: `${site.site_id}/${site.current_version}/index.html` }));
    expect(object.CacheControl).toBe('public, max-age=31536000, immutable');
    expect(object.ContentType).toBe('text/html; charset=utf-8');
  });

  it('updates without changing the URL, and rolls back instantly (R3, R4, R6)', async () => {
    const call = await as('alice');
    const first = (await call('publish', { files: page('<h1>v1</h1>'), title: 'Rollback test' })).json();
    const second = (await call('update', { site_id: first.site_id, files: page('<h1>v2</h1>') })).json();
    expect(second.url).toBe(first.url);
    expect(second.current_version).not.toBe(first.current_version);

    expect((await call('get_site', { site_id: first.site_id })).json().versions).toHaveLength(2);
    expect((await contents(call, first.site_id))['index.html']).toContain('v2');

    const back = await call('rollback', { site_id: first.site_id, version_id: first.current_version });
    expect(back.json().current_version).toBe(first.current_version);
    expect((await contents(call, first.site_id))['index.html']).toContain('v1');

    // An older version can still be read without making it current.
    expect((await contents(call, first.site_id, second.current_version))['index.html']).toContain('v2');
  });

  it('returns binary files as download links, never inline, and skips dotfiles', async () => {
    const call = await as('alice');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const r = (await call('publish', {
      files: [...page('<img src="dot.png">'), { path: 'dot.png', content: png.toString('base64'), encoding: 'base64' }, { path: '.env', content: 'SECRET=1' }],
      title: 'With an image',
    })).json();
    expect(r.skipped).toEqual(['.env']);
    expect(((await call('get_site', { site_id: r.site_id })).json().files as SiteFile[]).map((f) => f.path)).toEqual(['dot.png', 'index.html']);
    const [image] = (await call('get_files', { site_id: r.site_id, paths: ['dot.png'] })).json().files as SiteFile[];
    expect(image).toMatchObject({ content_type: 'image/png', size: png.length, sha256: sha256(png), download_url: expect.any(String) });
    expect(image?.content).toBeUndefined();
    expect(Buffer.from(await (await fetch(image?.download_url ?? '')).arrayBuffer())).toEqual(png);
  });

  it('finds the caller\'s own sites by title (R5)', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    await bob('publish', { files: page('bob'), title: 'Quarterly plans' });
    const found = (await alice('find_sites', { query: 'quarterly' })).json().sites as { title: string }[];
    expect(found.map((s) => s.title)).toEqual(['Quarterly numbers']);
    expect(((await bob('find_sites', {})).json().sites as unknown[])).toHaveLength(1);
  });
});

describe('reading a site (R4)', () => {
  it('lists file details and hashes, and returns contents only for the paths asked for', async () => {
    const call = await as('alice');
    const html = page('<h1>Details</h1>')[0]?.content ?? '';
    const site = (await call('publish', { title: 'Details', files: [...page('<h1>Details</h1>'), { path: 'site.css', content: 'h1{}' }] })).json();

    const listed = (await call('get_site', { site_id: site.site_id })).json().files as SiteFile[];
    expect(listed).toEqual([
      { path: 'index.html', size: html.length, content_type: 'text/html; charset=utf-8', sha256: sha256(html) },
      { path: 'site.css', size: 4, content_type: 'text/css; charset=utf-8', sha256: sha256('h1{}') },
    ]);

    expect((await call('get_files', { site_id: site.site_id, paths: ['site.css'] })).json()).toEqual({
      site_id: site.site_id,
      version: site.current_version,
      files: [{ path: 'site.css', size: 4, content_type: 'text/css; charset=utf-8', sha256: sha256('h1{}'), content: 'h1{}' }],
    });
    expect((await call('get_files', { site_id: site.site_id, paths: ['nope.html'] })).text).toBe('Not in this version: nope.html.');
    expect((await call('get_files', { site_id: site.site_id, paths: ['site.css'], version_id: 'nope' })).text).toBe('No version with that ID.');
  });

  it('returns text past the inline limit as a download link', async () => {
    const call = await as('alice');
    const big = (c: string) => `<!doctype html>${c.repeat(40 * 1024)}`;
    const site = (await call('publish', { title: 'Big', files: [{ path: 'a.html', content: big('a') }] })).json();
    await call('update', { site_id: site.site_id, files: [{ path: 'b.html', content: big('b') }] });
    const [a, b] = (await call('get_files', { site_id: site.site_id, paths: ['a.html', 'b.html'] })).json().files as SiteFile[];
    expect(a?.content).toBe(big('a'));
    expect(b?.content).toBeUndefined();
    expect(await (await fetch(b?.download_url ?? '')).text()).toBe(big('b'));
  });
});

describe('paging', () => {
  it('pages through a site\'s versions, newest first', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Many versions', files: page('v1') })).json();
    const ids = [site.current_version];
    for (const n of [2, 3, 4, 5]) ids.unshift((await call('update', { site_id: site.site_id, files: page(`v${n}`) })).json().current_version);

    const first = (await call('get_site', { site_id: site.site_id, limit: 2 })).json();
    expect((first.versions as { version_id: string }[]).map((v) => v.version_id)).toEqual(ids.slice(0, 2));
    expect(first.next_cursor).toBe(ids[1]);
    const second = (await call('get_site', { site_id: site.site_id, limit: 2, cursor: first.next_cursor })).json();
    expect((second.versions as { version_id: string }[]).map((v) => v.version_id)).toEqual(ids.slice(2, 4));
    const last = (await call('get_site', { site_id: site.site_id, limit: 2, cursor: second.next_cursor })).json();
    expect((last.versions as { version_id: string }[]).map((v) => v.version_id)).toEqual(ids.slice(4));
    expect(last.next_cursor).toBeUndefined();

    // The files listed are still the current version's, whichever page.
    expect(last.version).toBe(ids[0]);
    expect((await call('get_site', { site_id: site.site_id, limit: 5 })).json().next_cursor).toBeUndefined();
    expect((await call('get_site', { site_id: site.site_id, cursor: 'nope' })).text).toMatch(/^That cursor doesn't match/);
    expect((await call('get_site', { site_id: site.site_id, limit: 101 })).isError).toBe(true);
  });

  it('pages through the caller\'s sites, newest first, after filtering by title', async () => {
    await addUser(env, { id: 'erin' });
    const call = await as('erin');
    const titles = ['Report 1', 'Other', 'Report 2', 'Report 3'];
    for (const title of titles) await call('publish', { title, files: page(title) });

    const first = (await call('find_sites', { query: 'report', limit: 2 })).json();
    expect((first.sites as { title: string }[]).map((s) => s.title)).toEqual(['Report 3', 'Report 2']);
    const second = (await call('find_sites', { query: 'report', limit: 2, cursor: first.next_cursor })).json();
    expect((second.sites as { title: string }[]).map((s) => s.title)).toEqual(['Report 1']);
    expect(second.next_cursor).toBeUndefined();
    expect(((await call('find_sites', {})).json().sites as unknown[])).toHaveLength(4);
    expect((await call('find_sites', { cursor: 'nope' })).text).toMatch(/^That cursor doesn't match/);
  });
});

describe('updating part of a site (R3)', () => {
  const files = contents;

  it('changes only the files sent, and copies the rest', async () => {
    const call = await as('alice');
    const site = (await call('publish', {
      title: 'Three files',
      files: [...page('home v1'), { path: 'about.html', content: 'about' }, { path: 'site.css', content: 'h1{}' }],
    })).json();
    const r = (await call('update', { site_id: site.site_id, files: page('home v2') })).json();
    expect(r).toMatchObject({ files: 3, changed: 1, removed: 0 });
    expect(await files(call, site.site_id)).toEqual({ 'about.html': 'about', 'index.html': expect.stringContaining('home v2'), 'site.css': 'h1{}' });

    // Copied files keep their headers in the new version's own prefix.
    const copied = await env.s3.send(new GetObjectCommand({ Bucket: env.buckets.sites, Key: `${site.site_id}/${r.current_version}/site.css` }));
    expect(copied).toMatchObject({ ContentType: 'text/css; charset=utf-8', CacheControl: 'public, max-age=31536000, immutable' });

    // The first version is untouched.
    expect(await files(call, site.site_id, site.current_version)).toMatchObject({ 'index.html': expect.stringContaining('home v1') });
  });

  it('removes files, and refuses removals that make no sense', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Removals', files: [...page('home'), { path: 'old.html', content: 'old' }] })).json();
    expect((await call('update', { site_id: site.site_id, remove: ['old.html'] })).json()).toMatchObject({ files: 1, changed: 0, removed: 1 });
    expect(Object.keys(await files(call, site.site_id))).toEqual(['index.html']);

    expect((await call('update', { site_id: site.site_id, remove: ['missing.html'] })).text).toContain("not in the current version");
    expect((await call('update', { site_id: site.site_id, files: page('x'), remove: ['index.html'] })).text).toContain('both sent and removed');
    expect((await call('update', { site_id: site.site_id, remove: ['index.html'] })).text).toContain('no files left');
  });

  it('builds on the current version after a rollback', async () => {
    const call = await as('alice');
    const v1 = (await call('publish', { title: 'Branching', files: [...page('one'), { path: 'a.html', content: 'a' }] })).json();
    await call('update', { site_id: v1.site_id, remove: ['a.html'] });
    await call('rollback', { site_id: v1.site_id, version_id: v1.current_version });
    await call('update', { site_id: v1.site_id, files: [{ path: 'b.html', content: 'b' }] });
    expect(Object.keys(await files(call, v1.site_id))).toEqual(['a.html', 'b.html', 'index.html']);
  });

  it('replaces the whole site with replace_all', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Replace', files: [...page('home'), { path: 'about.html', content: 'about' }] })).json();
    expect((await call('update', { site_id: site.site_id, files: page('new'), replace_all: true })).json()).toMatchObject({ files: 1, changed: 1 });
    expect(Object.keys(await files(call, site.site_id))).toEqual(['index.html']);
  });

  it('changes the title and data details, with or without files', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Old title', files: page('x'), data_source: 'Sheet', data_as_of: '2026-10-01T00:00:00Z' })).json();
    const renamed = (await call('update', { site_id: site.site_id, title: 'New title', data_source: null })).json();
    expect(renamed).toMatchObject({ title: 'New title', current_version: site.current_version, changed: 0, data_as_of: '2026-10-01T00:00:00Z' });
    expect(renamed.data_source).toBeUndefined();
    expect((await call('get_site', { site_id: site.site_id })).json().versions).toHaveLength(1);

    const both = (await call('update', { site_id: site.site_id, files: page('y'), title: 'Newer title', data_as_of: '2026-10-31T00:00:00Z' })).json();
    expect(both).toMatchObject({ title: 'Newer title', data_as_of: '2026-10-31T00:00:00Z', changed: 1 });
    expect(((await call('find_sites', { query: 'newer' })).json().sites as { site_id: string }[]).map((f) => f.site_id)).toEqual([site.site_id]);
    expect((await call('update', { site_id: site.site_id, rules: [] })).text).toContain('To change only the rules, use set_access');
  });

  it('rejects update calls that say nothing, or mix replace_all with remove', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Invalid updates', files: page('x') })).json();
    for (const args of [{}, { replace_all: true }, { files: page('y'), remove: ['index.html'], replace_all: true }]) {
      expect((await call('update', { site_id: site.site_id, ...args })).text).toContain('Input validation error');
    }
  });

  it('refuses a version built on one that is no longer current', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Race', files: page('x') })).json();
    await call('update', { site_id: site.site_id, files: page('y') });
    const stale = { id: newVersionId(), siteId: String(site.site_id), files: [], size: 0, createdAt: new Date().toISOString(), createdBy: 'alice' };
    await expect(env.store.addVersion('alice', stale, String(site.current_version))).rejects.toBeInstanceOf(NotFoundOrConflict);
  });
});

describe('editing text files', () => {
  it('replaces text that appears exactly once, applying edits in order', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Edits', files: [...page('<h1>Helo wrold</h1><p>one</p>'), { path: 'site.css', content: 'h1{}' }] })).json();
    const r = (await call('update', {
      site_id: site.site_id,
      edits: [
        { path: 'index.html', old: 'Helo', new: 'Hello' },
        { path: 'index.html', old: 'Hello wrold', new: 'Hello world' },
      ],
    })).json();
    expect(r).toMatchObject({ files: 2, changed: 1, removed: 0 });
    expect(await contents(call, site.site_id)).toEqual({ 'index.html': expect.stringContaining('<h1>Hello world</h1><p>one</p>'), 'site.css': 'h1{}' });
  });

  it('refuses edits that don\'t match exactly once, and applies none of them', async () => {
    const call = await as('alice');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
    const site = (await call('publish', {
      title: 'Bad edits',
      files: [...page('<p>a</p><p>a</p>'), { path: 'dot.png', content: png.toString('base64'), encoding: 'base64' }, { path: 'site.css', content: 'h1{}' }],
    })).json();
    const r = await call('update', {
      site_id: site.site_id,
      edits: [
        { path: 'site.css', old: 'h1', new: 'h2' },
        { path: 'index.html', old: '<p>a</p>', new: '<p>b</p>' },
        { path: 'index.html', old: 'missing', new: 'x' },
        { path: 'dot.png', old: 'PNG', new: 'GIF' },
        { path: 'nope.html', old: 'x', new: 'y' },
      ],
    });
    expect(r.text).toBe('Publish refused: '
      + 'dot.png: only text files can be edited; send the whole file instead; '
      + 'index.html: edit 2\'s old text appears more than once; include more of the surrounding text; '
      + 'nope.html: not in the current version, so it can\'t be edited');
    expect((await call('update', { site_id: site.site_id, edits: [{ path: 'site.css', old: 'h9', new: 'x' }] })).text).toContain('edit 1\'s old text isn\'t in the file');
    expect((await call('get_site', { site_id: site.site_id })).json().current_version).toBe(site.current_version);
  });

  it('checks edited files like any other, and refuses edits mixed with sending or removing the same file', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Edit checks', files: [...page('<p>key</p>'), { path: 'a.html', content: 'a' }] })).json();
    const key = { path: 'index.html', old: 'key', new: `AKIA${'Q'.repeat(16)}` };
    expect((await call('update', { site_id: site.site_id, edits: [key] })).text).toContain('AWS access key');
    const fix = { path: 'a.html', old: 'a', new: 'b' };
    expect((await call('update', { site_id: site.site_id, edits: [fix], files: [{ path: 'a.html', content: 'c' }] })).text).toContain('a.html: both sent and edited');
    expect((await call('update', { site_id: site.site_id, edits: [fix], remove: ['a.html'] })).text).toContain('a.html: both edited and removed');
    expect((await call('update', { site_id: site.site_id, edits: [fix], files: page('x'), replace_all: true })).text).toContain('Input validation error');
  });
});

describe('base_version', () => {
  it('refuses an update when the site changed since the agent read it', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Stale reads', files: page('<p>v1</p>') })).json();
    const read = String(site.current_version);
    const other = (await call('update', { site_id: site.site_id, files: page('<p>v2</p>') })).json();
    expect((await call('update', { site_id: site.site_id, base_version: read, edits: [{ path: 'index.html', old: 'v1', new: 'v3' }] })).text)
      .toBe(`The site has changed since version ${read}: its current version is ${String(other.current_version)}. Get the site again and retry.`);
    expect((await call('update', { site_id: site.site_id, base_version: other.current_version, edits: [{ path: 'index.html', old: 'v2', new: 'v3' }] })).isError).toBe(false);
  });
});

describe('tool descriptions', () => {
  it('state this deployment\'s limits and grace period', async () => {
    const server = createServer(env, { userId: 'alice' }, () => undefined);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    const tools = Object.fromEntries((await client.listTools()).tools.map((t) => [t.name, t.description ?? '']));
    expect(tools.delete).toContain('after 7 days');
    expect(tools.publish).toContain('up to 64 KB in total');
    expect(tools.publish).toContain('Limits: 20 files, 128 KB per file, 256 KB per site.');
    expect(tools.begin_upload).toContain('valid for 15 minutes');
    expect(tools.begin_upload).toContain('curl -T');
    expect(tools.get_files).toContain('up to 64 KB in total');
  });
});

describe('public access (M2)', () => {
  const edgeRules = async (siteId: unknown) => JSON.parse(await env.edge.get(`s:${String(siteId)}`)).r;
  const PUBLIC = [{ path: '/', tier: 'public' }];

  it('makes a site public only when confirmed, and says exactly what is public (R34, R37)', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Going public', files: page('hi') })).json();
    expect(site.access).toBe('private');

    const unconfirmed = await call('set_access', { site_id: site.site_id, rules: PUBLIC });
    expect(unconfirmed.text).toBe('This would make / public: anyone with the link could open it without signing in. Check with the person first, then call again with confirm_public set to true.');
    expect(await edgeRules(site.site_id)).toEqual([]);

    const r = (await call('set_access', { site_id: site.site_id, rules: [...PUBLIC, { path: '/notes/', tier: 'private' }], confirm_public: true })).json();
    expect(r).toMatchObject({ access: 'mixed', made_public: ['/'], made_private: [], public_urls: [site.url] });
    expect(r.note).toBeUndefined();
    expect(await edgeRules(site.site_id)).toEqual([['/notes/', 'x'], ['/', 'p']]);

    // Shown by get_site and find_sites (R36).
    const got = (await call('get_site', { site_id: site.site_id })).json();
    expect(got).toMatchObject({ access: 'mixed', rules: [{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }] });
    const found = (await call('find_sites', { query: 'Going public' })).json().sites as { access: string }[];
    expect(found.map((f) => f.access)).toEqual(['mixed']);
  });

  it('needs confirming when removing a private rule exposes a folder', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Exposed', files: page('x'), rules: [...PUBLIC, { path: '/notes/', tier: 'private' }], confirm_public: true })).json();
    expect((await call('set_access', { site_id: site.site_id, rules: PUBLIC })).text).toContain('This would make /notes/ public');
    expect((await call('set_access', { site_id: site.site_id, rules: PUBLIC, confirm_public: true })).json()).toMatchObject({ made_public: ['/notes/'], access: 'public' });
  });

  it('makes things private without confirming, and warns about edge propagation (R40)', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Back to private', files: page('x'), rules: PUBLIC, confirm_public: true })).json();
    expect(site).toMatchObject({ access: 'public', public_urls: [site.url] });
    const r = (await call('set_access', { site_id: site.site_id, rules: [] })).json();
    expect(r).toMatchObject({ access: 'private', made_private: ['/'], public_urls: [], note: 'Paths made private can stay public at some edge locations for up to a minute.' });
    expect(r.rules).toBeUndefined();
    expect(await edgeRules(site.site_id)).toEqual([]);
  });

  it('refuses invalid rules, and public rules on publish without confirming, storing nothing', async () => {
    const call = await as('alice');
    const before = ((await call('find_sites', {})).json().sites as unknown[]).length;
    expect((await call('publish', { title: 'Unconfirmed', files: page('x'), rules: PUBLIC })).text).toContain('confirm_public');
    expect((await call('publish', { title: 'Bad rule', files: page('x'), rules: [{ path: '/docs', tier: 'public' }], confirm_public: true })).text)
      .toBe('Publish refused: "/docs": use / or a folder ending in /, such as /docs/');
    expect(((await call('find_sites', {})).json().sites as unknown[]).length).toBe(before);

    const site = (await call('publish', { title: 'Rules', files: page('x') })).json();
    const many = Array.from({ length: 21 }, (_, n) => ({ path: `/f${n}/`, tier: 'private' }));
    expect((await call('set_access', { site_id: site.site_id, rules: many })).text).toBe('Publish refused: more than 20 rules');
    expect((await call('set_access', { site_id: site.site_id, rules: [{ path: '/', tier: 'shared' }] })).text).toContain('Input validation error');
  });

  it('replaces rules with an update, or keeps them when none are sent (R35)', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Update rules', files: page('v1'), rules: PUBLIC, confirm_public: true })).json();
    expect((await call('update', { site_id: site.site_id, files: page('v2') })).json()).toMatchObject({ access: 'public' });
    const docs = [{ path: '/docs/', tier: 'public' }];
    expect((await call('update', { site_id: site.site_id, files: page('v3'), rules: docs })).json())
      .toMatchObject({ access: 'mixed', made_public: [], made_private: ['/'] });
    expect((await call('update', { site_id: site.site_id, files: page('v4'), rules: PUBLIC })).text).toContain('This would make / public');
    expect(await edgeRules(site.site_id)).toEqual([['/docs/', 'p']]);
  });

  it('keeps rules on the edge through updates and rollbacks', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Keeps rules', files: page('v1') })).json();
    await call('update', { site_id: site.site_id, files: page('v2') });
    await call('set_access', { site_id: site.site_id, rules: PUBLIC, confirm_public: true });
    await call('rollback', { site_id: site.site_id, version_id: site.current_version });
    expect(await edgeRules(site.site_id)).toEqual([['/', 'p']]);
  });

  it('refuses rule changes on sites that are being deleted, and on other people\'s sites', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await alice('publish', { title: 'Not changeable', files: page('x') })).json();
    expect((await bob('set_access', { site_id: site.site_id, rules: [] })).text).toBe('No site with that ID.');
    await alice('delete', { site_id: site.site_id });
    expect((await alice('set_access', { site_id: site.site_id, rules: PUBLIC, confirm_public: true })).text).toBe('This site is being deleted.');
  });

  it('refuses a rules write when the site changed after it was read', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Stale rules', files: page('x') })).json();
    const read = await env.store.getSite(String(site.site_id));
    await call('update', { site_id: site.site_id, files: page('y') });
    await expect(env.store.setRules('alice', String(site.site_id), [{ path: '/', tier: 'public' }], new Date().toISOString(), read?.updatedAt ?? ''))
      .rejects.toBeInstanceOf(NotFoundOrConflict);
  });

  it('records what each change made public or private (R48)', async () => {
    const events = (await eventsFor('alice')).filter((e) => e.action === 'set_access' && e.result === 'ok');
    expect(events.map((e) => e.detail)).toContain('made public: /; made private: nothing');
    expect(events.map((e) => e.detail)).toContain('made public: nothing; made private: /');
  });
});

describe('named sites (M2 R44–R48)', () => {
  const edgeValue = (key: string) => env.edge.get(key).catch(() => undefined);
  const record = async (siteId: unknown) => JSON.parse((await edgeValue(`s:${String(siteId)}`)) ?? 'null');

  it('names a site, which becomes its address everywhere', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Named', files: page('x') })).json();
    const r = (await call('set_name', { site_id: site.site_id, name: 'my-cv' })).json();
    expect(r).toMatchObject({ name: 'my-cv', url: 'https://my-cv.example.com/', name_change: { from: null, to: 'my-cv' } });
    expect(r.held).toBeUndefined();
    expect(await edgeValue('n:my-cv')).toBe(site.site_id);
    expect((await record(site.site_id)).n).toBe('my-cv');
    expect((await call('get_site', { site_id: site.site_id })).json()).toMatchObject({ name: 'my-cv', url: 'https://my-cv.example.com/' });
    expect(((await call('find_sites', { query: 'my-cv' })).json().sites as { site_id: string }[]).map((f) => f.site_id)).toEqual([site.site_id]);
    // Public URLs use the name too.
    expect((await call('set_access', { site_id: site.site_id, rules: [{ path: '/docs/', tier: 'public' }], confirm_public: true })).json().public_urls).toEqual(['https://my-cv.example.com/docs/']);
  });

  it('refuses names that are malformed, reserved, look like IDs, or are taken', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await bob('publish', { title: 'Wants a name', files: page('x') })).json();
    const mine = (await alice('publish', { title: 'Has a name', files: page('x') })).json();
    await alice('set_name', { site_id: mine.site_id, name: 'taken' });
    for (const [name, text] of [
      ['my--cv', 'Use 2–40 lowercase letters'],
      ['www', 'That name is reserved.'],
      ['blog', 'That name is reserved.'],
      [String(site.site_id), 'That looks like a site ID'],
      ['taken', 'That name is taken.'],
    ]) expect((await bob('set_name', { site_id: site.site_id, name })).text, name).toContain(text);
    // Not even the owner can take a name another of their sites is using.
    const second = (await alice('publish', { title: 'Second', files: page('x') })).json();
    expect((await alice('set_name', { site_id: second.site_id, name: 'taken' })).text).toBe('That name is taken.');
    expect((await bob('set_name', { site_id: mine.site_id, name: 'other' })).text).toBe('No site with that ID.');
  });

  it('holds the old name after a rename: it still points here, and only the owner can claim it', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await alice('publish', { title: 'Renamed', files: page('x') })).json();
    await alice('set_name', { site_id: site.site_id, name: 'old-name' });
    const r = (await alice('set_name', { site_id: site.site_id, name: 'new-name' })).json();
    expect(r).toMatchObject({ url: 'https://new-name.example.com/', name_change: { from: 'old-name', to: 'new-name' }, held: { name: 'old-name' } });
    expect(Date.parse((r.held as { until: string }).until) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect([await edgeValue('n:old-name'), await edgeValue('n:new-name'), (await record(site.site_id)).n]).toEqual([site.site_id, site.site_id, 'new-name']);

    const theirs = (await bob('publish', { title: 'Bob\'s', files: page('x') })).json();
    expect((await bob('set_name', { site_id: theirs.site_id, name: 'old-name' })).text).toBe('That name is taken.');
    // The owner can claim it again, for any of their sites.
    const other = (await alice('publish', { title: 'Other', files: page('x') })).json();
    expect((await alice('set_name', { site_id: other.site_id, name: 'old-name' })).isError).toBe(false);
    expect(await edgeValue('n:old-name')).toBe(other.site_id);
  });

  it('frees a held name once its hold has passed, even before DynamoDB removes it', async () => {
    const alice = await as('alice');
    const site = (await alice('publish', { title: 'Let go', files: page('x') })).json();
    await alice('set_name', { site_id: site.site_id, name: 'let-go' });
    const removed = (await alice('set_name', { site_id: site.site_id, name: null })).json();
    expect(removed).toMatchObject({ url: site.url, name_change: { from: 'let-go', to: null } });
    expect((await record(site.site_id)).n).toBeUndefined();

    const later = new Date(Date.now() + 8 * 86_400_000);
    const bob = await as('bob', later);
    const theirs = (await bob('publish', { title: 'Bob claims it', files: page('x') })).json();
    expect((await bob('set_name', { site_id: theirs.site_id, name: 'let-go' })).isError).toBe(false);
    expect(await edgeValue('n:let-go')).toBe(theirs.site_id);
    // Purging alice's site later doesn't touch bob's name.
    await alice('delete', { site_id: site.site_id, now: true });
    expect(await edgeValue('n:let-go')).toBe(theirs.site_id);
    expect((await env.store.getName('let-go'))?.siteId).toBe(theirs.site_id);
  });

  it('removes an expired name from the edge, unless it was claimed again', async () => {
    const alice = await as('alice');
    const site = (await alice('publish', { title: 'Expiring', files: page('x') })).json();
    await alice('set_name', { site_id: site.site_id, name: 'expiring' });
    await alice('set_name', { site_id: site.site_id, name: null });
    const publisher = new Publisher({ ...env, now: () => new Date(Date.now() + 8 * 86_400_000) });
    await publisher.expireName('expiring');
    expect(await edgeValue('n:expiring')).toBeUndefined();

    await alice('set_name', { site_id: site.site_id, name: 'reclaimed' });
    await new Publisher(env).expireName('reclaimed');
    expect(await edgeValue('n:reclaimed')).toBe(site.site_id);
  });

  it('keeps a deleted site\'s names until it is purged, then removes them everywhere', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await alice('publish', { title: 'Purged', files: page('x') })).json();
    await alice('set_name', { site_id: site.site_id, name: 'purged-a' });
    await alice('set_name', { site_id: site.site_id, name: 'purged-b' });
    await alice('delete', { site_id: site.site_id });
    const theirs = (await bob('publish', { title: 'Waiting', files: page('x') })).json();
    expect((await bob('set_name', { site_id: theirs.site_id, name: 'purged-b' })).text).toBe('That name is taken.');
    expect((await alice('set_name', { site_id: site.site_id, name: 'x-y' })).text).toBe('This site is being deleted.');

    await alice('delete', { site_id: site.site_id, now: true });
    expect([await edgeValue('n:purged-a'), await edgeValue('n:purged-b')]).toEqual([undefined, undefined]);
    expect([await env.store.getName('purged-a'), await env.store.getName('purged-b')]).toEqual([undefined, undefined]);
    expect((await bob('set_name', { site_id: theirs.site_id, name: 'purged-b' })).isError).toBe(false);
  });

  it('records every change of name (R48)', async () => {
    const details = (await eventsFor('alice')).filter((e) => e.action === 'set_name' && e.result === 'ok').map((e) => e.detail);
    expect(details).toContain('name: none → my-cv');
    expect(details).toContain('name: old-name → new-name');
    expect(details).toContain('name: let-go → none');
  });
});

describe('ownership and access (R8)', () => {
  it('treats another publisher\'s site exactly like a missing one', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await alice('publish', { files: page('mine'), title: 'Private' })).json();
    const missing = 'calm-heron-bcdfgh';
    for (const [name, args] of [
      ['get_site', {}],
      ['get_files', { paths: ['index.html'] }],
      ['update', { files: page('theirs') }],
      ['rollback', { version_id: site.current_version }],
      ['delete', { now: true }],
    ] as const) {
      const theirs = await bob(name, { site_id: site.site_id, ...args });
      const none = await bob(name, { site_id: missing, ...args });
      expect(theirs.isError, name).toBe(true);
      expect(theirs.text, name).toBe(none.text);
    }
    expect((await alice('get_site', { site_id: site.site_id })).isError).toBe(false);
  });

  it('refuses disabled users and users who are not publishers', async () => {
    for (const userId of ['carol', 'dave', 'nobody']) {
      const call = await as(userId);
      const r = await call('find_sites', {});
      expect(r).toMatchObject({ isError: true, text: 'This account cannot publish.' });
    }
  });
});

describe('input validation and publish checks (R9, R14)', () => {
  it('rejects unknown fields and ambiguous content, and records the rejection', async () => {
    const call = await as('bob');
    expect((await call('find_sites', { query: 'x', extra: true })).isError).toBe(true);
    expect((await call('publish', { title: 'Both', files: page('x'), upload_id: 'a'.repeat(22) })).isError).toBe(true);
    expect((await call('publish', { title: 'Neither' })).isError).toBe(true);
    expect((await call('publish', { title: 'Bad encoding', files: [{ path: 'index.html', content: 'x', encoding: 'hex' }] })).isError).toBe(true);
    const rejected = (await eventsFor('bob')).filter((e) => e.detail === 'invalid input');
    expect(rejected.map((e) => e.action).sort()).toEqual(['find_sites', 'publish', 'publish', 'publish']);
  });

  it('refuses unsafe sites and stores nothing', async () => {
    const call = await as('bob');
    const before = (await call('find_sites', {})).json().sites as unknown[];
    const cases = [
      [{ path: '_passa/x.html', content: 'x' }],
      [{ path: '../index.html', content: 'x' }],
      [{ path: 'index.html', content: `key=${'AKIA' + 'Q'.repeat(16)}` }],
      [{ path: 'photo.png', content: '<script></script>' }],
      [{ path: 'index.html', content: 'x'.repeat(70 * 1024) }],
    ];
    for (const files of cases) {
      const r = await call('publish', { title: 'Bad', files });
      expect(r.isError, files[0]?.path).toBe(true);
      expect(r.text).toMatch(/^Publish refused: /);
    }
    expect((await call('find_sites', {})).json().sites).toHaveLength(before.length);
  });
});

describe('uploads (R2)', () => {
  async function put(url: string, body: string) {
    return fetch(url, { method: 'PUT', body });
  }

  it('publishes a site from presigned uploads, once', async () => {
    const call = await as('alice');
    const html = '<!doctype html><h1>Uploaded</h1>';
    const css = 'h1 { color: rebeccapurple }';
    const begun = (await call('begin_upload', { files: [{ path: 'index.html', size: html.length }, { path: 'site.css', size: css.length }, { path: '.DS_Store', size: 4 }] })).json();
    expect(begun.skipped).toEqual(['.DS_Store']);
    const uploads = begun.uploads as { path: string; url: string }[];
    expect(uploads.map((u) => u.path)).toEqual(['index.html', 'site.css']);

    expect((await call('publish', { upload_id: begun.upload_id, title: 'Too early' })).text).toBe('Call finish_upload first.');
    const notYet = await call('finish_upload', { upload_id: begun.upload_id });
    expect(notYet.text).toContain('not uploaded');

    for (const u of uploads) expect((await put(u.url, u.path === 'index.html' ? html : css)).ok).toBe(true);
    expect((await call('finish_upload', { upload_id: begun.upload_id })).json()).toMatchObject({ ready: true, files: 2 });

    const site = (await call('publish', { upload_id: begun.upload_id, title: 'Uploaded site' })).json();
    expect(site.files).toBe(2);
    expect(await contents(call, site.site_id)).toEqual({ 'index.html': html, 'site.css': css });

    // The upload is used up, and its staging files are gone.
    expect((await call('publish', { upload_id: begun.upload_id, title: 'Again' })).text).toBe('No upload with that ID.');
    const staged = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.uploads, Prefix: `${begun.upload_id}/` }));
    expect(staged.KeyCount ?? 0).toBe(0);
  });

  it('refuses an upload that doesn\'t match what was declared, or belongs to someone else', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const begun = (await alice('begin_upload', { files: [{ path: 'index.html', size: 5 }] })).json();
    const [upload] = begun.uploads as [{ url: string }];
    const response = await put(upload.url, 'longer than five');
    // S3 refuses the wrong length outright; if an emulator accepts it, finish_upload must not.
    if (response.ok) expect((await alice('finish_upload', { upload_id: begun.upload_id })).text).toContain('expected 5');
    expect((await bob('finish_upload', { upload_id: begun.upload_id })).text).toBe('No upload with that ID.');
    expect((await alice('begin_upload', { files: [{ path: 'big.html', size: 200 * 1024 }] })).text).toContain('file limit');
  });
});

describe('delete (R7)', () => {
  it('starts a grace period, then deletes immediately when asked', async () => {
    const call = await as('alice');
    const site = (await call('publish', { files: page('bye'), title: 'Temporary' })).json();
    const soft = (await call('delete', { site_id: site.site_id })).json();
    expect(soft.deleted).toBe(false);
    expect(Date.parse(String(soft.delete_at)) - Date.now()).toBeGreaterThan(6.9 * 86_400_000);
    expect((await call('get_site', { site_id: site.site_id })).json().status).toBe('deleting');
    expect((await call('update', { site_id: site.site_id, files: page('back') })).text).toBe('This site is being deleted.');

    expect((await call('delete', { site_id: site.site_id, now: true })).json()).toEqual({ site_id: site.site_id, deleted: true });
    expect((await call('get_site', { site_id: site.site_id })).text).toBe('No site with that ID.');
    const left = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.sites, Prefix: `${site.site_id}/` }));
    expect(left.KeyCount ?? 0).toBe(0);
  });
});

describe('events (R31)', () => {
  it('records each change with user, IP and result', async () => {
    const events = await eventsFor('alice');
    const publishes = events.filter((e) => e.action === 'publish' && e.result === 'ok');
    expect(publishes.length).toBeGreaterThan(0);
    expect(publishes[0]).toMatchObject({ userId: 'alice', ip: '203.0.113.7', siteId: expect.any(String) });
    expect(events.some((e) => e.action === 'get_site' && e.result === 'ok')).toBe(false); // successful reads aren't recorded
    expect(events.some((e) => e.action === 'delete' && e.result === 'ok')).toBe(true);
    expect(logs).toEqual([]);
  });
});
