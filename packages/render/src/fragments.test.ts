// Fragments and embeds (M7 R168–R173), on the spec's family site.
import { describe, expect, it } from 'vitest';
import { HTMX, REFUSING, render, ruleId, type Source } from './index.ts';

const site = { path: '_site.yml', content: 'title: Home\ntiers: [family]\naccess:\n  /: [public]\n  /family/: [family]\n' };
const cards = { path: 'family/cards.md', content: '---\nfragment: true\ntags: [family]\ndate: 2026-11-01\n---\n- [[about|About us]]\n' };
const home = (embed: string) => ({ path: 'index.md', content: `# Home\n\n\`\`\`fragment\n${embed}\n\`\`\`\n` });
const about = { path: 'about.md', content: '---\ndate: 2026-10-01\ntags: [family]\n---\n# About\n\nAbout the family, at some length, for the excerpt.' };

const build = (sources: Source[], extra: { cards?: boolean } = {}) => {
  const result = render({ sources, siteUrl: 'https://home.example/', ...(extra.cards ? { cards: { fileHash: () => 'x' } } : {}) });
  return { ...result, html: (path: string) => result.pages.find((p) => p.path === path)?.html ?? '', kinds: result.problems.map((p) => p.kind) };
};

describe('fragments (M7 R168–R170)', () => {
  it('renders a fragment at its pretty URL as its content in a wrapper, with no layout', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]')]);
    const page = r.pages.find((p) => p.path === 'family/cards/index.html');
    expect(page).toMatchObject({ fragment: true, tier: 'members', from: 'family/cards.md' });
    expect(page?.html).toMatch(/^<div class="passa-fragment">\n<ul>\n<li><a href="\/about\/" class="wikilink">About us<\/a><\/li>/);
    expect(page?.html).not.toContain('<html');
    expect(page?.html).not.toContain('<script');
    expect(r.problems).toEqual([]);
  });

  it('leaves fragments out of lists, tags, backlinks, previous and next, the feed and cards', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]'),
      { path: '_layouts/list.html', content: '{{#pages}}{{url}} {{/pages}}|{{#prev}}{{url}}{{/prev}}|{{#next}}{{url}}{{/next}}' },
      { path: 'family/notes.md', content: '---\nlayout: list\ndate: 2026-10-15\n---\n' }], { cards: true });
    // A family page lists what family members open, and is dated between the two.
    expect(r.html('family/notes/index.html')).toBe('/about/ |/about/|');
    expect(r.html('tags/family/index.html')).not.toContain('/family/cards/');
    expect(r.html('about/index.html')).not.toContain('Linked from');
    expect(r.feed).toContain('/about/');
    expect(r.feed).not.toContain('/family/cards/');
    expect(r.cards?.map((c) => c.path)).not.toContainEqual(expect.stringContaining('family/cards'));
  });

  it('refuses the home page as a fragment', () => {
    const r = build([site, { path: 'index.md', content: '---\nfragment: true\n---\nHi' }]);
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'fragment', source: 'index.md' }));
  });
});

describe('embeds (M7 R171–R173)', () => {
  it('renders a placeholder HTMX fills: the fragment URL, its rule, the trigger and the fallback', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]\ntrigger: revealed\nfallback: Family members see links here.')]);
    expect(r.html('index.html')).toContain(`<div class="passa-embed" hx-get="/family/cards/" hx-trigger="revealed" hx-swap="innerHTML" data-passa-rule="${ruleId('/family/')}"><p>Family members see links here.</p>\n</div>`);
  });

  it('takes src as an unquoted or quoted wikilink, or a plain path, and loads on load by default', () => {
    for (const src of ['[[family/cards]]', '"[[family/cards]]"', 'family/cards', '"[[cards|the cards]]"']) {
      const r = build([site, cards, about, home(`src: ${src}`)]);
      expect(r.problems).toEqual([]);
      expect(r.html('index.html')).toContain('hx-get="/family/cards/" hx-trigger="load"');
    }
  });

  it('adds the block\'s classes to the placeholder, which stays when the fragment loads into it', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]\nclass: family-cards wide')]);
    expect(r.html('index.html')).toContain('<div class="passa-embed family-cards wide" hx-get="/family/cards/" hx-trigger="load" hx-swap="innerHTML"');
  });

  it('marks nothing for a public fragment', () => {
    const r = build([site, about, { path: 'news.md', content: '---\nfragment: true\n---\nNews' }, home('src: [[news]]')]);
    expect(r.html('index.html')).toContain('<div class="passa-embed" hx-get="/news/" hx-trigger="load" hx-swap="innerHTML"></div>');
  });

  it('loads Passa\'s HTMX only on pages with an embed', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]')]);
    expect(HTMX).toBe('/_passa/htmx-4.0.0.min.js');
    expect(r.html('index.html')).toContain(`<script src="${HTMX}"></script>`);
    expect(r.html('about/index.html')).not.toContain('htmx');
  });

  it('doesn\'t warn that some readers can\'t open an embedded fragment', () => {
    const r = build([site, cards, about, home('src: [[family/cards]]')]);
    expect(r.kinds).not.toContain('link-hidden');
  });

  it('refuses an embed without a src, of a page that isn\'t a fragment, of no page, or with an unknown trigger', () => {
    const cases: [string, string][] = [
      ['trigger: load', 'needs src'],
      ['src: [[about]]', 'about.md, which isn\'t a fragment'],
      ['src: [[nowhere]]', 'doesn\'t match any page'],
      ['src: [[family/cards]]\ntrigger: hover', 'not hover'],
      ['- a list', 'needs src'],
      ['src: [[family/cards]]\nclass: \'x" onclick="y\'', 'class names separated by spaces'],
    ];
    for (const [embed, message] of cases) {
      const r = build([site, cards, about, home(embed)]);
      expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'fragment', source: 'index.md', message: expect.stringContaining(message) }));
      expect(r.html('index.html')).not.toContain('passa-embed');
    }
    expect(REFUSING.has('fragment')).toBe(true);
  });
});

describe('the login block (M7 R177)', () => {
  const login = (block: string, path = 'family/notes.md') => build([site, cards, about, home('src: [[family/cards]]'), { path, content: `# Notes\n\n\`\`\`login\n${block}\n\`\`\`\n` }]);

  it('renders a sign-in link back to the page, which the edge replaces once signed in', () => {
    const r = login('');
    expect(r.problems).toEqual([]);
    expect(r.html('family/notes/index.html')).toContain('<div class="passa-login" hx-get="/_passa/login?show_user=false" hx-trigger="load" hx-swap="innerHTML"><a class="passa-login-link" href="/_passa/signin?path=%2Ffamily%2Fnotes%2F">Sign in</a></div>');
    expect(r.html('family/notes/index.html')).toContain(`<script src="${HTMX}"></script>`);
  });

  it('takes show_user, a label and classes', () => {
    const html = login('show_user: true\nlabel: Family <sign in>\nclass: top-right').html('family/notes/index.html');
    expect(html).toContain('<div class="passa-login top-right" hx-get="/_passa/login?show_user=true"');
    expect(html).toContain('>Family &lt;sign in&gt;</a>');
  });

  it('returns to the home page from a fragment, which is shown on other pages', () => {
    const r = login('', 'family/bar.md');
    const inFragment = build([site, about, { path: 'bar.md', content: '---\nfragment: true\n---\n```login\n```\n' }]);
    expect(r.problems).toEqual([]);
    expect(inFragment.html('bar/index.html')).toContain('href="/_passa/signin?path=%2F"');
  });

  it('refuses a login block it can\'t read', () => {
    for (const [block, message] of [['show_user: yes please', 'true or false'], ['class: "a;b"', 'class names'], ['- a', 'as YAML']] as const) {
      expect(login(block).problems).toContainEqual(expect.objectContaining({ kind: 'fragment', message: expect.stringContaining(message) }));
    }
  });
});
