import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRules } from './deploy.ts';
import { initSite } from './init.ts';
import { buildSite } from './site.ts';

const main = new URL('./main.ts', import.meta.url).pathname;
const site = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'passa-cli-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
};
const html = (build: ReturnType<typeof buildSite>, path: string) => build.pages.find((p) => p.path === path)?.html ?? '';
const listLayout = { '_layouts/default.html': '<link href="/theme.css" rel="stylesheet">{{{content}}}|{{#pages}}[{{title}}]{{/pages}}' };

describe('without a rules file (R93)', () => {
  const root = site({
    'index.md': '---\ntitle: Home\naccess: public\n---\nSee [[Plan]] and ![logo](logo.png).',
    'post.md': '---\ntitle: Post\naccess: public\ndate: 2026-01-01\n---\nPublic post.',
    'plan.md': '---\ntitle: Plan\n---\nSecret plan. ![chart](secret-chart.png)',
    'logo.png': 'png', 'secret-chart.png': 'png', 'unused.txt': 'x',
    'theme.css': 'body{background:url(img/paper.png)} @import "extra.css";', 'img/paper.png': 'png', 'extra.css': '',
    ...listLayout,
  });
  const build = buildSite(root);

  it('builds only pages marked access: public', () => {
    expect(build.access).toBe('front-matter');
    expect(build.pages.map((p) => p.path).sort()).toEqual(['index.html', 'post/index.html']);
    expect(build.skippedPages).toEqual(['plan.md']);
    for (const p of build.pages) expect(p.html).not.toContain('Secret');
  });

  it('counts links to pages that aren\'t public, without calling them problems', () => {
    expect(build.linksToSkipped).toBe(1);
    expect(build.problems).toEqual([]);
    expect(html(build, 'index.html')).toContain('<span class="wikilink missing">Plan</span>');
  });

  it('copies only files the built pages use, following stylesheets', () => {
    expect(build.files).toEqual(['extra.css', 'img/paper.png', 'logo.png', 'theme.css']);
    expect(build.skippedFiles).toEqual(expect.arrayContaining(['secret-chart.png', 'unused.txt']));
  });

  it('builds everything with --include-private, without a feed', () => {
    const all = buildSite(root, { includePrivate: true });
    expect(all.access).toBe('everything');
    expect(all.pages.map((p) => p.path)).toContain('plan/index.html');
    expect(all.files).toContain('secret-chart.png');
    expect(all.feed).toBeUndefined();
  });
});

describe('with a rules file', () => {
  const root = site({
    '_passa/access.yml': '- { path: /, tier: public }\n- { path: /notes/, tier: private }\n',
    'index.md': '# Home',
    'post.md': '---\ntitle: Post\n---\nPublic.',
    'notes/plan.md': '---\ntitle: Secret plan\naccess: public\n---\nPrivate, whatever the front matter says.',
    ...listLayout,
  });
  const build = buildSite(root);

  it('decides access by the rules, ignoring front matter', () => {
    expect(build.access).toBe('rules');
    expect(build.pages.map((p) => p.path)).not.toContain('notes/plan/index.html');
    expect(build.skippedPages).toEqual(['notes/plan.md']);
    for (const p of build.pages) expect(p.html).not.toContain('Secret');
  });

  it('never serves the rules file or other _passa files', () => {
    expect(build.files.some((f) => f.startsWith('_passa/'))).toBe(false);
  });
});

describe('refusals, as a publish would', () => {
  it('refuses a page that would replace a plain file', () => {
    const build = buildSite(site({ 'plan.md': '---\naccess: public\n---\nA', 'plan/index.html': '<p>B</p>' }));
    expect(build.refusing.map((p) => p.kind)).toContain('conflict');
  });

  it('refuses a page marked private that the rules make public, until confirmed', () => {
    const root = site({ '_passa/access.yml': '- { path: /, tier: public }\n', 'a.md': '---\naccess: private\n---\nA' });
    expect(buildSite(root).refusing.map((p) => p.kind)).toEqual(['access-private-made-public']);
    expect(buildSite(root, { confirmPublic: true }).refusing).toEqual([]);
  });
});

describe('passa init', () => {
  it('starts a site that builds as it is, and never overwrites', () => {
    const root = mkdtempSync(join(tmpdir(), 'passa-init-'));
    expect(initSite(root)).toEqual(['_site.yml', 'index.md', 'first-post.md']);
    const build = buildSite(root);
    expect(build.fromMarkdown).toBe(2);
    expect(build.problems).toEqual([]);
    expect(() => initSite(root)).toThrow(/already exist/);
  });
});

describe('the passa command', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: 'utf8' });

  it('check exits 1 when there are problems, 0 when there are none', () => {
    expect(run('check', site({ 'a.md': '---\naccess: public\n---\n[[Nowhere]]' })).status).toBe(1);
    expect(run('check', site({ 'a.md': '---\naccess: public\n---\nFine.' })).status).toBe(0);
  });

  it('render writes the site, and only replaces a folder it built', () => {
    const root = site({ 'a.md': '---\naccess: public\n---\nHello.' });
    const out = mkdtempSync(join(tmpdir(), 'passa-out-'));
    expect(run('render', root, '--out', out).status).toBe(0);
    expect(readFileSync(join(out, 'a/index.html'), 'utf8')).toContain('Hello.');
    expect(run('render', root, '--out', out).status).toBe(0); // its own build: replaced
    const other = site({ 'keep.txt': 'mine' });
    const refused = run('render', root, '--out', other);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('wasn\'t built by passa');
    expect(existsSync(join(other, 'keep.txt'))).toBe(true);
  });

  it('render draws a social card beside each page, as Passa would', () => {
    const root = site({ 'a.md': '---\ntitle: Card test\naccess: public\n---\nHello.' });
    const out = mkdtempSync(join(tmpdir(), 'passa-out-'));
    const r = run('render', root, '--out', out);
    expect(r.stdout).toMatch(/with \d+ social cards?/);
    const page = readFileSync(join(out, 'a/index.html'), 'utf8');
    const card = /og:image" content="http:\/\/localhost:4321\/(a\/_card-[0-9a-f]{20}\.png)"/.exec(page)?.[1] ?? '';
    expect(readFileSync(join(out, card)).subarray(1, 4).toString()).toBe('PNG');
  });

  it('theme guide prints the contract', () => {
    expect(run('theme', 'guide').stdout).toContain('# Passa theme guide');
  });
});

describe('access options', () => {
  it('turn --public, --private and --rule into rules', () => {
    expect(parseRules({ public: true })).toEqual([{ path: '/', tier: 'public' }]);
    expect(parseRules({ private: true })).toEqual([]);
    expect(parseRules({ rule: ['/=public', '/notes/=private'] })).toEqual([{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }]);
    expect(parseRules({})).toBeUndefined();
    expect(() => parseRules({ rule: ['public'] })).toThrow(/<path>=<tier>/);
  });
});
