// The publishing tools end to end: an MCP client calls the server in memory,
// and the server stores into Moto.
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newVersionId, NotFoundOrConflict } from '@passa/shared';
import { beforeAll, describe, expect, it } from 'vitest';
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

async function as(userId: string) {
  const server = createServer(env, { userId, ip: '203.0.113.7' }, (msg, data) => logs.push({ msg, ...data }));
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
    expect(site.url).toMatch(/^https:\/\/[a-z2-9]{12}\.example\.com\/$/);
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

describe('ownership and access (R8)', () => {
  it('treats another publisher\'s site exactly like a missing one', async () => {
    const alice = await as('alice');
    const bob = await as('bob');
    const site = (await alice('publish', { files: page('mine'), title: 'Private' })).json();
    const missing = 'abcdefghijkm';
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
