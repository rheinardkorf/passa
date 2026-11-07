// R82–R85: lists, backlinks, tag pages and the feed never name a page the
// visitor of the listing page can't see. These are the tests the spec says
// must fail the build.
import { describe, expect, it } from 'vitest';
import { render, type Rule, type Source } from './index.ts';

const page = (path: string, title: string, extra = '') => ({ path, content: `---\ntitle: ${title}\ndate: 2026-10-0${(title.length % 9) + 1}\n${extra}---\n${title} body.` });
const listLayout = { path: '_layouts/default.html', content: '<h1>{{title}}</h1>{{{content}}}|{{#pages}}[{{title}}]{{/pages}}|{{#backlinks}}<{{title}}>{{/backlinks}}|{{#allTags}}#{{name}}{{/allTags}}|{{#related}}~{{title}}{{/related}}|{{#prev}}prev:{{title}}{{/prev}}{{#next}}next:{{title}}{{/next}}' };
const build = (sources: Source[], rules: Rule[]) => {
  const result = render({ sources, rules, siteUrl: 'https://demo.example/' });
  const html = (path: string) => result.pages.find((p) => p.path === path)?.html ?? '';
  return { ...result, html };
};

describe('public and private', () => {
  const site = build([
    { path: 'index.md', content: '# Home\n\nSee [[launch plan]] and [[About]].' },
    page('about.md', 'About', 'tags: [team]\n'),
    { path: 'notes/launch-plan.md', content: '---\ntitle: Secret launch plan\ndate: 2026-10-20\ntags: [team, launch]\n---\nPrivate. Links to [[About]].' },
    page('notes/salary.md', 'Secret salary review'),
    listLayout,
  ], [{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }]);

  it('never names a private page on a public page', () => {
    const publicPages = site.pages.filter((p) => p.tier === 'public');
    expect(publicPages.length).toBeGreaterThan(2);
    for (const p of publicPages) expect(p.html, p.path).not.toMatch(/Secret/);
  });

  it('lists public and private pages on a private page', () => {
    expect(site.html('notes/salary/index.html')).toMatch(/\[About\].*\[Secret launch plan\]|\[Secret launch plan\].*\[About\]/);
  });

  it('hides a backlink from a private page on a public one, and shows it on a private one', () => {
    expect(site.html('about/index.html')).not.toContain('<Secret');
    expect(site.html('notes/launch-plan/index.html')).toContain('<Home>');
  });

  it('keeps an author\'s own link to a private page, without adding its title', () => {
    expect(site.html('index.html')).toContain('href="/notes/launch-plan/"');
  });

  it('builds the feed from public pages only', () => {
    expect(site.feed).toContain('About');
    expect(site.feed).not.toMatch(/Secret/);
  });

  it('never gives a private-only tag a public page or a public mention', () => {
    expect(site.pages.map((p) => p.path)).not.toContain('tags/launch/index.html');
    for (const p of site.pages.filter((q) => q.tier === 'public')) expect(p.html).not.toContain('#launch');
    expect(site.html('tags/team/index.html')).not.toMatch(/Secret/);
  });
});

describe('tiers beyond public and private (M6)', () => {
  const site = build([
    page('post.md', 'Public post', 'tags: [garden]\n'),
    page('notes/plan.md', 'Owner plan', 'tags: [garden]\n'),
    page('team/brief.md', 'Team brief', 'tags: [garden]\n'),
    page('team/notes.md', 'Team notes', 'tags: [garden]\n'),
    page('paid/course.md', 'Paid course', 'tags: [garden]\n'),
    listLayout,
  ], [{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }, { path: '/team/', tier: 'shared' }, { path: '/paid/', tier: 'paid:course' }]);

  it('shows a shared page public and shared pages only', () => {
    const html = site.html('team/brief/index.html');
    expect(html).toContain('Public post');
    expect(html).toContain('Team notes');
    expect(html).not.toMatch(/Owner plan|Paid course/);
  });

  it('never shows a paid page shared or owner-only pages', () => {
    expect(site.html('paid/course/index.html')).not.toMatch(/Team brief|Team notes|Owner plan/);
  });

  it('shows an owner-only page everything', () => {
    expect(site.html('notes/plan/index.html')).toMatch(/Team brief/);
    expect(site.html('notes/plan/index.html')).toMatch(/Paid course/);
  });
});

describe('the home page and hidden pages', () => {
  const site = build([
    { path: 'index.md', content: '# Home\n\nWelcome.' },
    page('a.md', 'Alpha'),
    page('b.md', 'Beta', 'hidden: true\n'),
    listLayout,
  ], [{ path: '/', tier: 'public' }]);

  it('never lists the home page', () => {
    expect(site.html('a/index.html')).not.toContain('[Home]');
  });

  it('renders a hidden page but leaves it out of lists and the feed', () => {
    expect(site.html('b/index.html')).toContain('Beta');
    expect(site.html('a/index.html')).not.toContain('[Beta]');
    expect(site.feed).not.toContain('Beta');
  });
});

describe('tags with no page', () => {
  const site = build([
    page('a.md', 'Alpha', 'tags: [shared]\n'),
    page('b.md', 'Beta', 'hidden: true\ntags: [shared, hidden-only]\n'),
    page('notes/c.md', 'Gamma', 'tags: [private-only]\n'),
    { path: '_layouts/default.html', content: '{{#tags}}{{name}}={{url}};{{/tags}}|{{#allTags}}{{name}}={{url}};{{/allTags}}' },
  ], [{ path: '/', tier: 'public' }, { path: '/notes/', tier: 'private' }]);

  it('never links a tag whose page doesn\'t exist', () => {
    expect(site.pages.map((p) => p.path)).not.toContain('tags/hidden-only/index.html');
    expect(site.html('b/index.html')).toContain('shared=/tags/shared/;hidden-only=;');
    // A private page lists its private-only tag, but /tags/ is public, so it has no page to link to.
    expect(site.html('notes/c/index.html')).toContain('private-only=;');
  });
});

describe('a site with no rules', () => {
  it('treats every page as private, as the edge does', () => {
    const site = build([page('a.md', 'Alpha'), listLayout], []);
    expect(site.pages.every((p) => p.tier === 'private')).toBe(true);
    expect(site.feed).toBeUndefined();
  });
});

describe('shared pages (M5 R137)', () => {
  const site = build([
    { path: 'index.md', content: '---\ntitle: Home\n---\nSee [[Plans]].' },
    { path: 'plans/index.md', content: '---\ntitle: Plans\ndate: 2026-11-01\n---\nBack to [[Home]].' },
    page('plans/q1.md', 'Q1 plan', 'access: private\n'),
    page('notes/secret.md', 'Secret notes'),
    listLayout,
  ], [{ path: '/plans/', tier: 'shared' }]);

  it('lists shared and public pages only, and leaves shared pages out of the feed', () => {
    expect(site.html('plans/index.html')).toContain('Q1 plan');
    expect(site.html('plans/index.html')).not.toContain('Secret notes');
    expect(site.feed ?? '').not.toMatch(/Plans|Q1 plan/);
  });

  it('reports links readers can\'t follow once for the site, and keeps them', () => {
    const hidden = site.problems.filter((p) => p.kind === 'link-hidden');
    expect(hidden).toEqual([{ kind: 'link-hidden', source: 'plans/index.md', message: 'A link goes to pages some of their readers can\'t open: plans/index.md → index.md (private). It stays, for those who can.' }]);
    expect(site.html('plans/index.html')).toContain('href="/"');
  });

  it('warns when a page that says private is shared, without refusing', () => {
    expect(site.problems.find((p) => p.kind === 'access-private-made-shared')?.message)
      .toBe('plans/q1.md says access: private, but the site\'s rules make /plans/q1/ shared, so everyone the site is shared with can open it');
  });
});

describe('shared with different people (M5)', () => {
  const site = build([
    page('proposals/acme/index.md', 'Acme proposal'),
    page('proposals/acme/pricing.md', 'Acme pricing'),
    page('proposals/globex/index.md', 'Globex proposal'),
    page('about.md', 'About us'),
    listLayout,
  ], [{ path: '/', tier: 'public' }, { path: '/proposals/acme/', tier: 'shared' }, { path: '/proposals/globex/', tier: 'shared' }]);

  it('lists only pages under the shared page\'s own rule, and public pages', () => {
    const acme = site.html('proposals/acme/index.html');
    expect(acme).toContain('Acme pricing');
    expect(acme).toContain('About us');
    expect(acme).not.toContain('Globex');
    expect(site.html('proposals/globex/index.html')).not.toContain('Acme');
  });

  it('still reports pages as shared', () => {
    expect(site.pages.find((p) => p.path === 'proposals/acme/index.html')?.tier).toBe('shared');
  });
});
