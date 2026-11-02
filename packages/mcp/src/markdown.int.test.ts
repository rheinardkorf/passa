// Publishing Markdown sites end to end (M3): sources are stored under
// _passa/src/, pages are rendered with every version, and unchanged pages are
// copied rather than written again.
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { newSiteId, newVersionId } from '@passa/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './server.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: () => Record<string, unknown> }>;
let call: Call;

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  const server = createServer(env, { userId: 'alice' }, () => undefined);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
});

type Folder = Record<string, string>;
type Listed = { path: string; sha256: string; role?: string; rendered_from?: string };
const filesOf = (folder: Folder) => Object.entries(folder).map(([path, content]) => ({ path, content }));
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
const PUBLIC = [{ path: '/', tier: 'public' }];

const site: Folder = {
  'index.md': '---\ntitle: Home\n---\n# Welcome\n\nSee [[Plan]] and [about](about.html).',
  'notes/plan.md': '---\ntitle: Plan\ndate: 2026-10-01\ntags: [work]\n---\nThe plan.',
  'about.html': '<!doctype html><title>About</title><p>About</p>',
  'style.css': 'p{color:red}',
};

async function listed(siteId: unknown, versionId?: unknown): Promise<Map<string, Listed>> {
  const files = (await call('get_site', { site_id: siteId, ...(versionId ? { version_id: versionId } : {}) })).json().files as Listed[];
  return new Map(files.map((f) => [f.path, f]));
}

async function read(siteId: unknown, versionId: unknown, key: string): Promise<string | undefined> {
  try {
    const { Body } = await env.s3.send(new GetObjectCommand({ Bucket: env.buckets.sites, Key: `${String(siteId)}/${String(versionId)}/${key}` }));
    return await Body?.transformToString();
  } catch {
    return undefined;
  }
}

// The files a version wrote new (staged for scanning), rather than copied.
async function staged(siteId: unknown, versionId: unknown): Promise<string[]> {
  const prefix = `inline/${String(siteId)}/${String(versionId)}/`;
  const { Contents = [] } = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.uploads, Prefix: prefix }));
  return Contents.map((c) => (c.Key ?? '').slice(prefix.length)).sort();
}

describe('publishing a Markdown site (M3 R67, R70, R86, R88)', () => {
  it('renders pages beside plain files, and keeps sources where they are never served', async () => {
    const r = (await call('publish', { title: 'Notes', files: filesOf(site) })).json();
    const files = await listed(r.site_id);
    // The site is private, so it has no feed.
    expect([...files.keys()].sort()).toEqual([
      '_passa/access.yml', 'about.html', 'index.html', 'index.md', 'notes/plan.md', 'notes/plan/index.html', 'style.css', 'tags/work/index.html',
    ]);
    expect(files.get('index.md')).toMatchObject({ role: 'source' });
    expect(files.get('notes/plan/index.html')).toMatchObject({ role: 'rendered', rendered_from: 'notes/plan.md' });
    expect(files.get('tags/work/index.html')).toMatchObject({ role: 'rendered' });
    expect(files.get('tags/work/index.html')?.rendered_from).toBeUndefined();
    expect(files.get('about.html')?.role).toBeUndefined();

    // Sources live under _passa/src/, which the edge never serves (R14).
    expect(await read(r.site_id, r.current_version, '_passa/src/index.md')).toBe(site['index.md']);
    expect(await read(r.site_id, r.current_version, 'index.md')).toBeUndefined();
    const home = await read(r.site_id, r.current_version, 'index.html');
    expect(home).toContain('href="/notes/plan/"');
    expect(await read(r.site_id, r.current_version, '_passa/access.yml')).toContain('[]');

    // get_files returns sources by their own paths.
    const got = (await call('get_files', { site_id: r.site_id, paths: ['notes/plan.md', '_passa/access.yml'] })).json().files as { path: string; content: string }[];
    expect(got.find((f) => f.path === 'notes/plan.md')?.content).toBe(site['notes/plan.md']);
  });

  it('copies pages that render the same, and writes only what changed', async () => {
    const first = (await call('publish', { title: 'Copies', files: filesOf(site) })).json();
    const second = (await call('update', { site_id: first.site_id, files: [{ path: 'style.css', content: 'p{color:blue}' }] })).json();
    expect(await staged(first.site_id, second.current_version)).toEqual(['style.css']);
    expect(second.changed).toBe(1);
    expect(await read(first.site_id, second.current_version, 'notes/plan/index.html')).toBe(await read(first.site_id, first.current_version, 'notes/plan/index.html'));

    // Editing a source renders its page again, and the pages that list it.
    const third = (await call('update', { site_id: first.site_id, edits: [{ path: 'notes/plan.md', old: 'title: Plan', new: 'title: The plan' }] })).json();
    expect(await staged(first.site_id, third.current_version)).toEqual(['_passa/src/notes/plan.md', 'notes/plan/index.html', 'tags/work/index.html']);
    expect(await read(first.site_id, third.current_version, 'notes/plan/index.html')).toContain('The plan');
  });

  it('refuses edits to and removals of rendered pages, pointing at the source (R87)', async () => {
    const r = (await call('publish', { title: 'Rendered', files: filesOf(site) })).json();
    const edit = await call('update', { site_id: r.site_id, edits: [{ path: 'notes/plan/index.html', old: 'plan', new: 'x' }] });
    expect(edit.text).toContain('notes/plan/index.html: rendered from notes/plan.md, so edit that instead');
    const remove = await call('update', { site_id: r.site_id, remove: ['tags/work/index.html'] });
    expect(remove.text).toContain('tags/work/index.html: rendered by Passa, so it can\'t be removed');

    // Removing the source removes its page.
    const gone = (await call('update', { site_id: r.site_id, remove: ['notes/plan.md'] })).json();
    const files = await listed(r.site_id, gone.current_version);
    expect(files.has('notes/plan/index.html')).toBe(false);
    expect(files.has('tags/work/index.html')).toBe(false);
  });

  it('refuses a page that would replace a file, or two sources rendering to one path (R68)', async () => {
    const r = (await call('publish', { title: 'Conflict', files: filesOf(site) })).json();
    const clash = await call('update', { site_id: r.site_id, files: [{ path: 'notes/plan/index.html', content: '<p>mine</p>' }] });
    expect(clash.text).toContain('notes/plan.md renders to notes/plan/index.html, which is already a file in the site');
    const twice = await call('update', { site_id: r.site_id, files: [{ path: 'notes/plan/index.md', content: 'Another plan' }] });
    expect(twice.text).toMatch(/both render to notes\/plan\/index\.html/);
    expect(((await call('get_site', { site_id: r.site_id })).json().versions as unknown[])).toHaveLength(1);
  });

  it('keeps a plain index.html as the home page, rather than generating one', async () => {
    const r = (await call('publish', { title: 'Mixed', files: [{ path: 'index.html', content: '<p>my home</p>' }, { path: 'post.md', content: 'A post.' }] })).json();
    expect(await read(r.site_id, r.current_version, 'index.html')).toBe('<p>my home</p>');
    expect((await listed(r.site_id)).get('post/index.html')).toMatchObject({ role: 'rendered' });
  });

  it('lists render problems in the result without refusing (R90)', async () => {
    const r = (await call('publish', { title: 'Problems', files: [{ path: 'index.md', content: 'See [[Nowhere]].' }] })).json();
    expect(r.problems).toEqual([expect.stringContaining('[[Nowhere]]')]);
  });

  it('refuses a layout a page names that doesn\'t exist (R79)', async () => {
    const r = await call('publish', { title: 'Layout', files: [{ path: 'index.md', content: '---\nlayout: fancy\n---\nHi' }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('fancy');
  });
});

describe('access (M3 R82, R88, R89)', () => {
  const rules = [...PUBLIC, { path: '/notes/', tier: 'private' }];
  const mixed: Folder = {
    'index.md': '# Home',
    'post.md': '---\ntitle: Post\ndate: 2026-10-02\ntags: [open]\n---\nSee [[Secret plan|my notes]].',
    'notes/secret.md': '---\ntitle: Secret plan\ndate: 2026-10-03\ntags: [hush]\n---\nPrivate.',
  };

  it('never names a private page on a public one, and carries the rules', async () => {
    const r = (await call('publish', { title: 'Mixed access', files: filesOf(mixed), rules, confirm_public: true })).json();
    const files = await listed(r.site_id);
    expect(files.has('tags/hush/index.html')).toBe(false); // used only on a private page
    expect(files.has('tags/open/index.html')).toBe(true);
    for (const path of ['index.html', 'post/index.html', 'tags/open/index.html', 'feed.xml']) {
      expect(await read(r.site_id, r.current_version, path), path).not.toContain('Secret plan');
    }
    // The author's own link is kept, as an HTML link would be.
    expect(await read(r.site_id, r.current_version, 'post/index.html')).toContain('href="/notes/secret/"');
    expect(await read(r.site_id, r.current_version, '_passa/access.yml')).toContain('- { path: "/notes/", tier: "private" }');
  });

  it('refuses a page marked access: private that the rules make public, until confirmed', async () => {
    const r = (await call('publish', { title: 'Marked private', files: filesOf({ 'index.md': '# Home' }), rules: PUBLIC, confirm_public: true })).json();
    const draft = { files: [{ path: 'diary.md', content: '---\naccess: private\n---\nDear diary' }] };
    const refused = await call('update', { site_id: r.site_id, ...draft });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('diary.md says access: private, but the site\'s rules make /diary/ public');
    expect(refused.text).toContain('confirm_public');
    expect((await call('update', { site_id: r.site_id, ...draft, confirm_public: true })).isError).toBe(false);
  });

  it('ignores a rules file sent with the site: only set_access changes access', async () => {
    const r = (await call('publish', { title: 'Sent rules', files: [...filesOf({ 'index.md': '# Home' }), { path: '_passa/access.yml', content: '- { path: /, tier: public }\n' }] })).json();
    expect(r.skipped).toEqual(['_passa/access.yml']);
    expect(r.access).toBe('private');
    expect(await read(r.site_id, r.current_version, '_passa/access.yml')).toContain('[]');
  });
});

describe('limits and sync (M3 R70, R87)', () => {
  it('counts a source and its page as one file', async () => {
    const pages = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `p${i}.md`, content: `Page ${i}` }));
    expect((await call('publish', { title: 'Twenty', files: pages(20) })).isError).toBe(false); // 20 sources, 20 pages, a home page and the rules
    expect((await call('publish', { title: 'Too many', files: pages(21) })).text).toContain('more than 20 files');
  });

  it('syncs a folder against sources and plain files, never rendered pages', async () => {
    const r = (await call('publish', { title: 'Synced', files: filesOf(site) })).json();
    const folder = { ...site, '_passa/access.yml': 'anything' };
    const manifest = Object.entries(folder).map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha256(content) }));
    const begun = (await call('begin_upload', { site_id: r.site_id, files: manifest })).json();
    expect(begun).toMatchObject({ up_to_date: true, skipped: ['_passa/access.yml'] });
  });
});

describe('sites from before M3', () => {
  it('turns Markdown stored as a plain file into a source on the next update', async () => {
    // A version as M1 stored it: index.md served as it is.
    const siteId = newSiteId();
    const content = '# Old notes';
    const now = new Date().toISOString();
    const version = {
      id: newVersionId(Date.now()), siteId, createdAt: now, createdBy: 'alice', size: content.length,
      files: [{ path: 'index.md', size: content.length, contentType: 'text/markdown; charset=utf-8', sha256: sha256(content) }],
    };
    await env.s3.send(new PutObjectCommand({ Bucket: env.buckets.sites, Key: `${siteId}/${version.id}/index.md`, Body: content }));
    await env.store.createSite({ id: siteId, ownerId: 'alice', title: 'Old', current: version.id, accessVersion: 1, status: 'active', createdAt: now, updatedAt: now }, version);

    const r = (await call('update', { site_id: siteId, files: [{ path: 'style.css', content: 'p{}' }] })).json();
    expect(r.isError).toBeUndefined();
    expect(await read(siteId, r.current_version, '_passa/src/index.md')).toBe(content);
    expect(await read(siteId, r.current_version, 'index.md')).toBeUndefined();
    expect(await read(siteId, r.current_version, 'index.html')).toContain('Old notes');
  });
});
