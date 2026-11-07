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
  ], [{ path: '/', access: ['public'] }, { path: '/notes/', access: 'private' }]);

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

describe('members, the course scenario (M6 R161)', () => {
  // The spec's scenario: tiers on folders, a page with its own tier, a
  // private exception, and a page with no rule at all.
  const site = build([
    page('about.md', 'About us', 'tags: [course]\n'),
    page('lessons/week-1.md', 'Week one', 'tags: [course]\n'),
    page('lessons/week-3/quiz.md', 'Quiz three', 'tags: [course]\n'),
    page('lessons/bonus/extra.md', 'Bonus extra', 'tags: [course]\n'),
    page('lessons/draft/idea.md', 'Draft idea', 'tags: [course]\n'),
    page('notes/plan.md', 'Owner plan', 'tags: [course]\n'),
    listLayout,
  ], [
    { path: '/about/', access: ['public'] },
    { path: '/lessons/', access: ['gold', 'silver'] },
    { path: '/lessons/bonus/', access: ['gold'] },
    { path: '/lessons/week-3/quiz/', access: ['silver'] },
    { path: '/lessons/draft/', access: 'private' },
  ]);

  it('lists on a members page what every one of its tiers can open', () => {
    const lessons = site.html('lessons/week-1/index.html'); // gold and silver
    expect(lessons).toContain('About us');
    expect(lessons).not.toMatch(/Bonus extra|Quiz three|Draft idea|Owner plan/);
    const bonus = site.html('lessons/bonus/extra/index.html'); // gold only: gold opens the lessons too
    expect(bonus).toContain('Week one');
    expect(bonus).not.toMatch(/Quiz three|Draft idea|Owner plan/);
    const quiz = site.html('lessons/week-3/quiz/index.html'); // silver only
    expect(quiz).toContain('Week one');
    expect(quiz).not.toMatch(/Bonus extra|Draft idea/);
  });

  it('lists on a page under a private rule only that rule\'s pages and public ones', () => {
    const draft = site.html('lessons/draft/idea/index.html');
    expect(draft).toContain('About us');
    expect(draft).not.toMatch(/Week one|Bonus extra|Owner plan/);
  });

  it('lists everything on an owner-only page with no rule', () => {
    expect(site.html('notes/plan/index.html')).toMatch(/Week one.*|Bonus extra/s);
    expect(site.html('notes/plan/index.html')).toContain('Draft idea');
  });

  it('reports each page as public, members or private', () => {
    const tier = (path: string) => site.pages.find((p) => p.path === path)?.tier;
    expect([tier('about/index.html'), tier('lessons/week-1/index.html'), tier('lessons/draft/idea/index.html'), tier('notes/plan/index.html')]).toEqual(['public', 'members', 'private', 'private']);
  });
});

describe('the home page and hidden pages', () => {
  const site = build([
    { path: 'index.md', content: '# Home\n\nWelcome.' },
    page('a.md', 'Alpha'),
    page('b.md', 'Beta', 'hidden: true\n'),
    listLayout,
  ], [{ path: '/', access: ['public'] }]);

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
  ], [{ path: '/', access: ['public'] }, { path: '/notes/', access: 'private' }]);

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

describe('pages under a private rule (M5 R137, M6)', () => {
  const site = build([
    { path: 'index.md', content: '---\ntitle: Home\n---\nSee [[Plans]].' },
    { path: 'plans/index.md', content: '---\ntitle: Plans\ndate: 2026-11-01\n---\nBack to [[Home]].' },
    page('plans/q1.md', 'Q1 plan'),
    page('notes/secret.md', 'Secret notes'),
    listLayout,
  ], [{ path: '/plans/', access: 'private' }]);

  it('lists only that rule\'s pages, and leaves them out of the feed', () => {
    expect(site.html('plans/index.html')).toContain('Q1 plan');
    expect(site.html('plans/index.html')).not.toContain('Secret notes');
    expect(site.feed ?? '').not.toMatch(/Plans|Q1 plan/);
  });

  it('reports links readers can\'t follow once for the site, and keeps them', () => {
    const hidden = site.problems.filter((p) => p.kind === 'link-hidden');
    expect(hidden).toEqual([{ kind: 'link-hidden', source: 'plans/index.md', message: 'A link goes to pages some of their readers can\'t open: plans/index.md → index.md (private). It stays, for those who can.' }]);
    expect(site.html('plans/index.html')).toContain('href="/"');
  });

  it('warns when a page that says private is opened to members, without refusing', () => {
    const members = build([page('lessons/q1.md', 'Q1', 'access: private\n'), listLayout], [{ path: '/lessons/', access: ['gold'] }]);
    expect(members.problems.find((p) => p.kind === 'access-private-made-members')?.message)
      .toBe('lessons/q1.md says access: private, but the site\'s rules open /lessons/q1/ to members (gold)');
  });
});
