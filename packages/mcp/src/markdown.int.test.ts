// Publishing Markdown sites end to end (M3): sources are stored under
// _passa/src/, pages are rendered with every version, and unchanged pages are
// copied rather than written again.
import { createHash } from 'node:crypto';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DEFAULT_CARD_FONTS, drawCard, render } from '@passa/render';
import { newSiteId, newVersionId, type Rule } from '@passa/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { Publisher } from './publisher.ts';
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
const PUBLIC: Rule[] = [{ path: '/', access: ['public'] }];

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
  const rules = [...PUBLIC, { path: '/notes/', access: 'private' }];
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
    expect(await read(r.site_id, r.current_version, '_passa/access.yml')).toContain('- { path: "/notes/", access: "private" }');
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
    const r = (await call('publish', { title: 'Sent rules', files: [...filesOf({ 'index.md': '# Home' }), { path: '_passa/access.yml', content: '- { path: /, access: [public] }\n' }] })).json();
    expect(r.skipped).toEqual(['_passa/access.yml']);
    expect(r.access).toBe('private');
    expect(await read(r.site_id, r.current_version, '_passa/access.yml')).toContain('[]');
  });
});

describe('access from the site\'s files (M6 R150, R151)', () => {
  const course = (access: string) => filesOf({
    '_site.yml': `title: Course\ntiers: [gold, silver]\naccess:\n${access}`,
    'index.md': '# Home',
    'lessons/week-1.md': '# Week one',
    'lessons/quiz.md': '---\naccess: [silver]\n---\n# Quiz',
  });

  it('takes the site\'s rules from _site.yml and front matter, confirming anything public', async () => {
    const refused = await call('publish', { title: 'Course', files: course('  /: [public]\n  /lessons/: [gold, silver]\n') });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('This would make / public');
    const site = (await call('publish', { title: 'Course', files: course('  /: [public]\n  /lessons/: [gold, silver]\n'), confirm_public: true })).json();
    expect(site.rules).toEqual([{ path: '/', access: ['public'] }, { path: '/lessons/', access: ['gold', 'silver'] }, { path: '/lessons/quiz/', access: ['silver'] }]);
    expect(site).toMatchObject({ access: 'mixed', made_public: ['/'], made_members: ['/lessons/', '/lessons/quiz/'] });
    expect(await read(site.site_id, site.current_version, '_passa/access.yml')).toContain('- { path: "/lessons/quiz/", access: ["silver"] }');
    expect((await env.store.getSite(String(site.site_id)))?.accessFromFiles).toBe(true);
  });

  it('refuses set_access and passed rules on such a site, and keeps the rules when the files stop declaring them', async () => {
    const site = (await call('publish', { title: 'Course', files: course('  /lessons/: [gold]\n') })).json();
    expect((await call('set_access', { site_id: site.site_id, rules: [] })).text).toContain('access comes from its files');
    expect((await call('update', { site_id: site.site_id, files: filesOf({ 'more.md': '# More' }), rules: [] })).text).toContain('rules can\'t be passed as well');
    // Tiers change in the file, and the rules with them.
    const changed = (await call('update', { site_id: site.site_id, files: filesOf({ '_site.yml': 'title: Course\ntiers: [gold, silver]\naccess:\n  /lessons/: [silver]\n' }) })).json();
    expect(changed.rules).toEqual([{ path: '/lessons/', access: ['silver'] }]);
    // No access in _site.yml any more: the rules stay as they were, and set_access works again.
    const stopped = (await call('update', { site_id: site.site_id, files: filesOf({ '_site.yml': 'title: Course\n' }) })).json();
    expect(stopped.rules).toEqual([{ path: '/lessons/', access: ['silver'] }]);
    expect((await env.store.getSite(String(site.site_id)))?.accessFromFiles).toBe(false);
    expect((await call('set_access', { site_id: site.site_id, rules: [] })).isError).toBe(false);
  });

  it('refuses a share needing a rule the files don\'t have, saying what to add', async () => {
    const shared = createServer({ ...env, mailer: { kind: 'memory', send: async () => undefined } }, { userId: 'alice' }, () => undefined);
    const client = new Client({ name: 'test', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([shared.connect(b), client.connect(a)]);
    const site = (await call('publish', { title: 'Course', files: course('  /lessons/: [gold]\n') })).json();
    const share = async (path: string) => ((await client.callTool({ name: 'share', arguments: { site_id: site.site_id, email: 'reviewer@example.com', path, confirm_share: true } })).content as { text: string }[])[0]?.text ?? '';
    expect(await share('/lessons/week-1/')).toContain('has no rule of its own for the share to open. Add one there with the access it has now ([gold])');
    expect(JSON.parse(await share('/lessons/')).share.path).toBe('/lessons/');
  });

  it('refuses tiers the site doesn\'t name', async () => {
    const r = await call('publish', { title: 'Bad tier', files: course('  /lessons/: [platinum]\n') });
    expect(r.text).toContain('platinum isn\'t a tier this site names');
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

describe('changes that re-render (M3 R71, R84, R85)', () => {
  // No index.md, so the home page is generated and lists every page it may name.
  const blog: Folder = {
    'post.md': '---\ntitle: Open post\ndate: 2026-10-02\n---\nHello.',
    'notes/secret.md': '---\ntitle: Secret plan\ndate: 2026-10-03\ntags: [hush]\n---\nPrivate.',
  };
  const versions = async (siteId: unknown) => ((await call('get_site', { site_id: siteId })).json().versions as unknown[]).length;

  it('makes a folder private and drops it from public lists in the same change', async () => {
    const r = (await call('publish', { title: 'Re-render', files: filesOf(blog), rules: PUBLIC, confirm_public: true })).json();
    expect(await read(r.site_id, r.current_version, 'index.html')).toContain('Secret plan');
    expect(await read(r.site_id, r.current_version, 'tags/hush/index.html')).toBeDefined();

    const changed = (await call('set_access', { site_id: r.site_id, rules: [...PUBLIC, { path: '/notes/', access: 'private' }] })).json();
    expect(changed).toMatchObject({ made_private: ['/notes/'], access: 'mixed' });
    expect(changed.current_version).not.toBe(r.current_version);
    expect(changed.version_id).toBe(changed.current_version);
    for (const path of ['index.html', 'feed.xml']) expect(await read(r.site_id, changed.current_version, path), path).not.toContain('Secret plan');
    expect((await listed(r.site_id)).has('tags/hush/index.html')).toBe(false);
    expect(await read(r.site_id, changed.current_version, '_passa/access.yml')).toContain('"/notes/"');
    expect(await versions(r.site_id)).toBe(2);
  });

  it('changes rules on a site without sources with no new version, as before', async () => {
    const r = (await call('publish', { title: 'Plain', files: [{ path: 'index.html', content: '<p>hi</p>' }] })).json();
    const changed = (await call('set_access', { site_id: r.site_id, rules: PUBLIC, confirm_public: true })).json();
    expect(changed.current_version).toBe(r.current_version);
    expect(await versions(r.site_id)).toBe(1);
  });

  it('follows a new name in absolute links and the feed', async () => {
    const r = (await call('publish', { title: 'Named', files: filesOf(blog), rules: PUBLIC, confirm_public: true })).json();
    expect(await read(r.site_id, r.current_version, 'feed.xml')).toContain(String(r.url));
    const named = (await call('set_name', { site_id: r.site_id, name: 'rerender-test' })).json();
    expect(named.url).toContain('rerender-test');
    const feed = await read(r.site_id, named.current_version, 'feed.xml');
    expect(feed).toContain(`${String(named.url)}post/`);
    expect(feed).not.toContain(String(r.site_id));
  });

  it('rolls back by rendering the old sources with the current rules', async () => {
    const r = (await call('publish', { title: 'Rollback', files: filesOf(blog), rules: PUBLIC, confirm_public: true })).json();
    const first = r.current_version;
    await call('set_access', { site_id: r.site_id, rules: [...PUBLIC, { path: '/notes/', access: 'private' }] });
    const back = (await call('rollback', { site_id: r.site_id, version_id: first })).json();
    expect(back.restored_from).toBe(first);
    expect(back.current_version).not.toBe(first);
    expect(await read(r.site_id, back.current_version, 'index.html')).not.toContain('Secret plan');
  });

  it('refuses a rollback that would make a page marked private public, until confirmed', async () => {
    const r = (await call('publish', {
      title: 'Marked', files: filesOf({ 'diary.md': '---\naccess: private\n---\nDear diary', 'index.md': '# Home' }),
      rules: [...PUBLIC, { path: '/diary/', access: 'private' }], confirm_public: true,
    })).json();
    const first = r.current_version;
    // Removing the page, then opening the folder: rolling back would publish it.
    await call('update', { site_id: r.site_id, remove: ['diary.md'] });
    await call('set_access', { site_id: r.site_id, rules: PUBLIC, confirm_public: true });
    const refused = await call('rollback', { site_id: r.site_id, version_id: first });
    expect(refused.text).toContain('diary.md says access: private');
    expect((await call('rollback', { site_id: r.site_id, version_id: first, confirm_public: true })).isError).toBe(false);
  });
});

describe('social cards (M3 R94–R97)', () => {
  const posts: Folder = {
    'index.md': '# Home',
    'post.md': '---\ntitle: A post worth sharing\ndate: 2026-10-02\n---\nHello.',
  };
  const cardsOf = async (siteId: unknown) => {
    const { Contents = [] } = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.sites, Prefix: `${String(siteId)}/cards/` }));
    return Contents.map((c) => c.Key ?? '');
  };
  const cardUrl = (html: string | undefined) => /og:image" content="[^"]*\/(_card-[0-9a-f]{20})\.png"/.exec(html ?? '')?.[1];

  it('draws a card for each public page, outside versions, and names it in the page', async () => {
    const r = (await call('publish', { title: 'Cards', files: filesOf(posts), rules: PUBLIC, confirm_public: true })).json();
    expect(r.cards_waiting).toBeUndefined();
    const card = cardUrl(await read(r.site_id, r.current_version, 'post/index.html'));
    expect(card).toBeDefined();
    const stored = await cardsOf(r.site_id);
    expect(stored).toContain(`${String(r.site_id)}/cards/${String(card).slice('_card-'.length)}.png`);
    const { ContentType, CacheControl } = await env.s3.send(new GetObjectCommand({ Bucket: env.buckets.sites, Key: stored[0] }));
    expect([ContentType, CacheControl]).toEqual(['image/png', 'public, max-age=31536000, immutable']);

    // An update that doesn't change what a card shows draws nothing new.
    const before = stored.length;
    await call('update', { site_id: r.site_id, files: [{ path: 'style.css', content: 'p{}' }] });
    expect((await cardsOf(r.site_id)).length).toBe(before);
    // A new title is a new card; the old one stays for earlier versions.
    const renamed = (await call('update', { site_id: r.site_id, edits: [{ path: 'post.md', old: 'A post worth', new: 'A post very much worth' }] })).json();
    expect(cardUrl(await read(r.site_id, renamed.current_version, 'post/index.html'))).not.toBe(card);
    expect((await cardsOf(r.site_id)).length).toBe(before + 1);
  });

  it('draws no cards for a private site', async () => {
    const r = (await call('publish', { title: 'Private cards', files: filesOf(posts) })).json();
    expect(await cardsOf(r.site_id)).toEqual([]);
    expect(await read(r.site_id, r.current_version, 'post/index.html')).not.toContain('og:image');
  });

  it('draws what a publish had no time for afterwards', async () => {
    const later: string[] = [];
    const publisher = new Publisher({ ...env, cardBudgetMs: 0, drawCardsLater: (siteId, versionId) => Promise.resolve(void later.push(`${siteId}/${versionId}`)) });
    const enc = (text: string) => new TextEncoder().encode(text);
    const r = await publisher.publish({ userId: 'alice' }, { title: 'Later', content: { files: Object.entries(posts).map(([path, text]) => ({ path, content: enc(text) })) }, rules: PUBLIC, confirmPublic: true });
    expect(r).toMatchObject({ cards_waiting: 2 });
    expect(later).toEqual([`${r.site_id}/${r.current_version}`]);
    expect(await publisher.drawPendingCards(r.site_id, r.current_version)).toEqual({ drawn: 2, waiting: 0, failed: [] });
    expect(await cardsOf(r.site_id)).toHaveLength(2);
    // Nothing left to draw, and nothing for a version that's no longer current.
    expect(await publisher.drawPendingCards(r.site_id, r.current_version)).toMatchObject({ drawn: 0 });
    expect(await publisher.drawPendingCards(r.site_id, newVersionId(1))).toMatchObject({ drawn: 0 });
  });

  it('refuses a theme card that names an image from elsewhere', async () => {
    const r = await call('publish', {
      title: 'Remote card', rules: PUBLIC, confirm_public: true,
      files: filesOf({ ...posts, '_layouts/card.html': '<div style="display:flex"><img src="https://example.org/x.png" width="10" height="10"></div>' }),
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('cards can only use the site\'s own images');
  });
});

describe('cards drawn outside Passa (M3 R97)', () => {
  const posts: Folder = { 'index.md': '# Home', 'post.md': '---\ntitle: Drawn at home\n---\nHello.' };
  const enc = (text: string) => new TextEncoder().encode(text);
  let publisher: Publisher;
  beforeAll(() => {
    publisher = new Publisher({ ...env, cardBudgetMs: 0 }); // Passa draws nothing itself
  });
  const alice = { userId: 'alice' };
  // What passa render would make: the same render, drawn locally.
  // The site title is on the card, so the local build uses the same one (a real site sets it in _site.yml).
  const local = (siteUrl: string, siteTitle: string) =>
    render({ sources: Object.entries(posts).map(([path, content]) => ({ path, content })), rules: PUBLIC, siteUrl, siteTitle, cards: { fileHash: () => undefined } }).cards ?? [];
  const png = (html: string) => drawCard(html, { fonts: DEFAULT_CARD_FONTS, image: () => undefined });

  it('stores the cards a version names, so Passa needn\'t draw them, and skips the rest', async () => {
    const r = await publisher.publish(alice, { title: 'Home-drawn', content: { files: Object.entries(posts).map(([path, text]) => ({ path, content: enc(text) })) }, rules: PUBLIC, confirmPublic: true });
    expect(r).toMatchObject({ cards_waiting: 2 });
    const cards = local(r.url, 'Home-drawn');
    // The local build names the same cards as Passa.
    expect(await read(r.site_id, r.current_version, 'post/index.html')).toContain(cards.find((c) => c.path.startsWith('post/'))?.path);

    const sent = await Promise.all(cards.map(async (c) => ({ path: c.path, content: await png(c.html) })));
    const stray = { path: 'post/_card-ffffffffffffffffffff.png', content: sent[0]?.content ?? new Uint8Array() };
    const u = await publisher.update(alice, { siteId: r.site_id, content: { files: [...sent, stray] } });
    expect(u).toMatchObject({ cards_stored: 2, cards_skipped: ['post/_card-ffffffffffffffffffff.png: no public page in this version names this card'] });
    expect(u).not.toHaveProperty('cards_waiting');
    // Cards aren't site files.
    expect((await listed(r.site_id)).has(cards[0]?.path ?? '')).toBe(false);
    const { Contents = [] } = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.sites, Prefix: `${r.site_id}/cards/` }));
    expect(Contents).toHaveLength(2);
    // Staged for scanning, like any new file.
    const staged = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.uploads, Prefix: `inline/${r.site_id}/cards/` }));
    expect(staged.Contents).toHaveLength(2);

    // A folder sync with the cards in it uploads none of them again.
    const folder = Object.entries(posts).map(([path, text]) => ({ path, size: enc(text).byteLength, sha256: sha256(text) }));
    const begun = await publisher.beginUpload(alice, { siteId: r.site_id, files: [...folder, ...sent.map((c) => ({ path: c.path, size: c.content.byteLength }))] });
    expect(begun).toMatchObject({ up_to_date: true });
  });

  it('refuses a card that isn\'t a 1200×630 PNG', async () => {
    const r = await publisher.publish(alice, { title: 'Wrong card', content: { files: Object.entries(posts).map(([path, text]) => ({ path, content: enc(text) })) }, rules: PUBLIC, confirmPublic: true });
    const card = local(r.url, 'Wrong card')[0];
    const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await expect(publisher.update(alice, { siteId: r.site_id, content: { files: [{ path: card?.path ?? '', content: new Uint8Array(tiny) }] } })).rejects.toThrow('a card must be a 1200×630 PNG');
  });
});
