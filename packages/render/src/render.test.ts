import { describe, expect, it } from 'vitest';
import { REFUSING, THEME_GUIDE, render, type Source } from './index.ts';

const publicSite = [{ path: '/', tier: 'public' }];
const build = (sources: Source[], extra: { files?: string[]; rules?: { path: string; tier: string }[] } = {}) => {
  const result = render({ sources, rules: extra.rules ?? publicSite, siteUrl: 'https://demo.example/', ...(extra.files ? { files: extra.files } : {}) });
  return { ...result, html: (path: string) => result.pages.find((p) => p.path === path)?.html ?? '', kinds: result.problems.map((p) => p.kind) };
};
const layout = (content: string) => ({ path: '_layouts/default.html', content });

describe('rendering (R67–R71)', () => {
  it('turns sources into pages at folder paths', () => {
    const r = build([{ path: 'index.md', content: '# Home' }, { path: 'notes/plan.md', content: '# Plan' }]);
    expect(r.pages.map((p) => p.path).sort()).toEqual(['index.html', 'notes/plan/index.html']);
  });

  it('refuses a page that would replace a plain file', () => {
    const r = build([{ path: 'plan.md', content: '# Plan' }], { files: ['plan/index.html'] });
    expect(r.kinds).toContain('conflict');
    expect(REFUSING.has('conflict')).toBe(true);
  });

  it('refuses two sources rendering to one path', () => {
    const r = build([{ path: 'plan.md', content: 'A' }, { path: 'plan/index.md', content: 'B' }]);
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'conflict', message: 'plan/index.md and plan.md both render to plan/index.html' }));
  });

  it('lets a plain file win over a generated home page, tag page or feed', () => {
    const sources = [{ path: 'post.md', content: '---\ndate: 2026-01-01\ntags: [work]\n---\nA post.' }];
    expect(build(sources).pages.map((p) => p.path).sort()).toEqual(['index.html', 'post/index.html', 'tags/work/index.html']);
    const r = build(sources, { files: ['index.html', 'tags/work/index.html', 'feed.xml'] });
    expect(r.pages.map((p) => p.path)).toEqual(['post/index.html']);
    expect(r.feed).toBeUndefined();
    expect(r.html('post/index.html')).not.toContain('href="/tags/work/"');
    expect(r.problems).toEqual([]);
  });

  it('takes the title from front matter, then the first heading, then the file name', () => {
    const r = build([
      { path: 'a.md', content: '---\ntitle: From front matter\n---\n# Heading' },
      { path: 'b.md', content: '# From heading' },
      { path: 'c-file.md', content: 'No heading.' },
      layout('{{title}}'),
    ]);
    expect(r.html('a/index.html')).toBe('From front matter');
    expect(r.html('b/index.html')).toBe('From heading');
    expect(r.html('c-file/index.html')).toBe('c-file');
  });

  it('keeps a draft as source but renders no page', () => {
    const r = build([{ path: 'draft.md', content: '---\ndraft: true\n---\nNot yet.' }, { path: 'index.md', content: '# Home' }]);
    expect(r.pages.map((p) => p.path)).not.toContain('draft/index.html');
  });

  it('reports front matter that isn\'t YAML', () => {
    expect(build([{ path: 'a.md', content: '---\ntitle: [unclosed\n---\nBody' }]).kinds).toContain('front-matter');
  });
});

describe('Markdown (R72–R75)', () => {
  const r = build([
    { path: 'index.md', content: '# Home\n\n> [!tip] Remember\n> Callouts work.\n\n- [x] done\n- [ ] todo\n\n```ts\nconst x = 1;\n```\n\nSee [[Plan]], [[notes/plan|the plan]], [plan](notes/plan.md), [[Nowhere]] and ![pic](images/a.png).\n' },
    { path: 'notes/plan.md', content: '---\ntitle: Plan\n---\nUp: [home](../index.md) and ![chart](chart.png).' },
    layout('{{{content}}}'),
  ]);
  const home = r.html('index.html');

  it('renders callouts, task lists and highlighted code with its language', () => {
    expect(home).toMatch(/<blockquote class="callout callout-tip">\s*<p class="callout-title">Remember<\/p><p>Callouts work.<\/p>/);
    expect(home).toContain('<li class="task"><input type="checkbox" disabled checked> done');
    expect(home).toContain('<pre class="hljs" data-lang="ts"><code class="language-ts">');
  });

  it('resolves wikilinks by title and path, and links with .md', () => {
    expect(home.match(/href="\/notes\/plan\/"/g)).toHaveLength(3);
  });

  it('marks a missing wikilink and reports it', () => {
    expect(home).toContain('<span class="wikilink missing">Nowhere</span>');
    expect(r.problems).toContainEqual(expect.objectContaining({ kind: 'missing-link', source: 'index.md' }));
  });

  it('rewrites relative links and images from the source\'s folder', () => {
    expect(home).toContain('src="/images/a.png"');
    const plan = r.html('notes/plan/index.html');
    expect(plan).toContain('href="/"');
    expect(plan).toContain('src="/notes/chart.png"');
  });
});

describe('widgets (R76, R77)', () => {
  const body = [
    '```cards\n- title: "[[Plan]]"\n  text: Short.\n```',
    '```stats\n- { label: Years, value: 11 }\n```',
    '```chart\ntype: bar\ntitle: Posts <b>\nvalues: { "2019": 4, "2020": 14 }\n```',
    '```gallery\n![A cat](cat.png)\n```',
    '```timeline\n2014: Built **it**\n```',
    '```mermaid\nflowchart LR\n  A --> B\n```',
    '```cards\n- [unclosed\n```',
    '```unknown\nleft alone\n```',
  ].join('\n\n');
  const r = build([{ path: 'index.md', content: `# Home\n\n${body}` }, { path: 'plan.md', content: '# Plan' }]);
  const home = r.html('index.html');

  it('renders the built-ins with w- classes', () => {
    expect(home).toContain('<ul class="w-cards"><li class="w-card"><p class="w-card-title"><a href="/plan/" class="wikilink">Plan</a></p>');
    expect(home).toContain('<dl class="w-stats"><div class="w-stat"><dt>Years</dt><dd>11</dd></div></dl>');
    expect(home).toContain('<div class="w-gallery"><figure><img src="/cat.png" alt="A cat"');
    expect(home).toContain('<span class="w-what">Built <strong>it</strong></span>');
    expect(home).toContain('<pre class="mermaid">flowchart LR');
  });

  it('draws a chart as SVG at publish time, escaping its labels', () => {
    expect(home).toMatch(/<figure class="w-chart w-chart-bar">.*<figcaption>Posts &lt;b&gt;<\/figcaption><svg/s);
    expect(home).toContain('class="w-chart-series w-series-1"');
  });

  it('loads Mermaid only on pages with a diagram', () => {
    const plain = build([{ path: 'a.md', content: '# A' }, layout('{{mermaid}}')]);
    const withDiagram = build([{ path: 'a.md', content: '```mermaid\ngraph TD\n```' }, layout('{{mermaid}}')]);
    expect(plain.html('a/index.html')).toBe('');
    expect(withDiagram.html('a/index.html')).toContain('mermaid@12.2.0');
  });

  it('shows invalid widget data as code and reports it', () => {
    expect(home).toContain('<code class="language-cards">- [unclosed');
    expect(r.kinds).toContain('widget');
  });

  it('leaves other fence names as code blocks', () => {
    expect(home).toContain('<code class="language-unknown">left alone');
  });

  it('uses a theme\'s own widget, with options, positions and inline Markdown', () => {
    const t = build([
      { path: 'index.md', content: '```quote size=big\n- { text: "**Bold** words" }\n- { text: Second }\n```' },
      { path: '_layouts/widgets/quote.html', content: '<q data-size="{{options.size}}">{{#items}}{{index}}{{#isFirst}}!{{/isFirst}}:{{#markdown}}{{text}}{{/markdown}};{{/items}}</q>' },
    ]);
    expect(t.html('index.html')).toContain('<q data-size="big">1!:<strong>Bold</strong> words;2:Second;</q>');
  });

  it('lets a theme replace a built-in', () => {
    const t = build([{ path: 'index.md', content: '```stats\n- { label: A, value: 1 }\n```' }, { path: '_layouts/widgets/stats.html', content: '<mine>{{#items}}{{label}}{{/items}}</mine>' }]);
    expect(t.html('index.html')).toContain('<mine>A</mine>');
  });
});

describe('themes and the template contract (R78–R81)', () => {
  it('uses the default theme when a site has no layouts', () => {
    const r = build([{ path: 'index.md', content: '# Home' }]);
    expect(r.html('index.html')).toMatch(/^<!doctype html>/);
  });

  it('lists a tag\'s pages in the default theme, and links tags that have a page', () => {
    const r = build([{ path: 'index.md', content: '# Home' }, { path: 'post.md', content: '---\ntitle: A post\ndate: 2026-01-01\ntags: [work]\n---\nText.' }]);
    expect(r.html('tags/work/index.html')).toMatch(/<h1>work<\/h1>[\s\S]*<a href="\/post\/">A post<\/a>/);
    expect(r.html('post/index.html')).toContain('<a href="/tags/work/">work</a>');
  });

  it('chooses layouts: front matter, home, kind, then default', () => {
    const r = build([
      { path: 'index.md', content: '# Home' },
      { path: 'short.md', content: '# Short\n\nA few words.' },
      { path: 'talk.md', content: '---\nkind: talk\n---\n# Talk' },
      { path: 'custom.md', content: '---\nlayout: special\n---\n# Custom' },
      { path: '_layouts/home.html', content: 'home' },
      { path: '_layouts/note.html', content: 'note' },
      { path: '_layouts/talk.html', content: 'talk' },
      { path: '_layouts/special.html', content: 'special' },
      layout('default'),
    ]);
    expect(['index.html', 'short/index.html', 'talk/index.html', 'custom/index.html'].map(r.html)).toEqual(['home', 'note', 'talk', 'special']);
  });

  it('refuses a page that names a missing layout', () => {
    const r = build([{ path: 'a.md', content: '---\nlayout: nope\n---\nBody' }]);
    expect(r.kinds).toContain('layout');
    expect(r.pages).toHaveLength(1); // the generated home page only
  });

  it('gives every list item its position, with rest continuing from featured', () => {
    const r = build([
      ...['a', 'b', 'c'].map((n, i) => ({ path: `${n}.md`, content: `---\ntitle: ${n.toUpperCase()}\ndate: 2026-01-0${3 - i}\ntags: [x, y]\n---\nBody` })),
      { path: '_layouts/index.html', content: '{{#featured}}F{{index}}{{title}}{{/featured}}|{{#rest}}{{index}}{{title}}{{#isLast}}.{{/isLast}}{{/rest}}|{{pageCount}}{{#onePage}}one{{/onePage}}' },
      layout('{{#tags}}{{index}}{{name}}{{#isFirst}}^{{/isFirst}}{{/tags}}'),
    ]);
    expect(r.html('index.html')).toBe('F1A|2B3C.|3');
    expect(r.html('a/index.html')).toBe('1x^2y');
  });

  it('keeps the current page under page, even inside lists and the hero', () => {
    const r = build([
      { path: 'a.md', content: '---\ntitle: Alpha\nhero:\n  text: Hi\n  image: hero.png\n---\nBody' },
      { path: 'b.md', content: '---\ntitle: Beta\n---\nBody' },
      layout('{{#pages}}{{title}}/{{page.title}}{{/pages}}|{{#hero}}{{hero.image}}:{{page.title}}{{/hero}}'),
    ]);
    expect(r.html('a/index.html')).toBe('Beta/Alpha|/hero.png:Alpha');
  });

  it('formats dates in the site\'s locale, groups years, and marks the current nav item', () => {
    const r = build([
      { path: '_site.yml', content: 'locale: en-US\nnav:\n  - { title: Notes, url: /notes/ }\n  - { title: Home, url: / }' },
      { path: 'notes/a.md', content: '---\ntitle: A\ndate: 2026-10-31\n---\nBody' },
      { path: 'notes/b.md', content: '---\ntitle: B\n---\nBody' },
      layout('{{dateLong}}|{{#nav}}{{title}}{{#current}}*{{/current}}{{/nav}}|{{lang}}|{{#years}}{{year}}({{count}}){{/years}}'),
    ]);
    expect(r.html('notes/a/index.html')).toBe('October 31, 2026|Notes*Home|en-US|Undated(1)');
  });

  it('splits content into sections at thematic breaks, for decks', () => {
    const r = build([{ path: 'talk.md', content: '---\nlayout: deck\n---\n# One\n\n---\n\n## Two\n\n> [!notes]\n> Say hi.' }]);
    const html = r.html('talk/index.html');
    expect(html.match(/<section class="slide"/g)).toHaveLength(2);
    expect(html).toContain('callout-notes');
  });

  it('builds the excerpt from prose, skipping labels and lone links', () => {
    const r = build([
      { path: 'a.md', content: '# A\n\nResources:\n\nhttps://example.com\n\nThis paragraph reads as real prose about the page.' },
      layout('{{excerpt}}'),
    ]);
    expect(r.html('a/index.html')).toBe('This paragraph reads as real prose about the page.');
  });

  it('escapes front matter in layouts', () => {
    const r = build([{ path: 'a.md', content: '---\ntitle: <script>x</script>\n---\nBody' }, layout('{{title}}')]);
    expect(r.html('a/index.html')).toBe('&lt;script&gt;x&lt;/script&gt;');
  });

  it('has a theme guide covering the contract', () => {
    for (const term of ['page.', 'featured', 'sections', 'w-cards', '_layouts/widgets/', 'Content Security Policy']) expect(THEME_GUIDE).toContain(term);
  });
});

describe('round 4 values: decks, positions, heroes, social', () => {
  it('makes a deck a kind of its own, still listed', () => {
    const r = build([
      { path: 'talk.md', content: '---\ntitle: Talk\nlayout: deck\n---\n# One\n\n---\n\n# Two' },
      { path: 'post.md', content: '---\ntitle: Post\n---\nBody' },
      layout('{{#pages}}{{title}}:{{kind}}{{#isDeck}}!{{/isDeck}};{{/pages}}'),
    ]);
    expect(r.html('post/index.html')).toBe('Talk:deck!;');
  });

  it('counts sections and pads positions', () => {
    const r = build([
      { path: 'talk.md', content: '---\nlayout: slides\n---\nOne\n\n---\n\nTwo\n\n---\n\nThree' },
      { path: '_layouts/slides.html', content: '{{#sections}}{{indexPadded}}/{{sectionCount}} {{/sections}}' },
    ]);
    expect(r.html('talk/index.html')).toBe('01/3 02/3 03/3 ');
  });

  it('lets a hero replace a leading # heading', () => {
    const r = build([
      { path: 'a.md', content: '---\nhero:\n  text: Opening\n---\n# The heading\n\nBody text.' },
      { path: 'b.md', content: '# Plain\n\nBody text.' },
      layout('{{showTitle}}|{{title}}|{{{content}}}'),
    ]);
    expect(r.html('a/index.html')).toBe('false|The heading|<p>Body text.</p>\n');
    expect(r.html('b/index.html')).toContain('<h1 id="plain">Plain</h1>');
  });

  it('gives absolute URLs and a social image: socialImage, then cover, then the hero\'s', () => {
    const r = build([
      { path: 'notes/a.md', content: '---\nsocialImage: share.png\ncover: cover.png\n---\nA' },
      { path: 'notes/b.md', content: '---\ncover: cover.png\n---\nB' },
      { path: 'notes/c.md', content: '---\nhero:\n  image: /img/hero.png\n---\nC' },
      { path: 'notes/d.md', content: 'D' },
      layout('{{absoluteUrl}} {{socialImage}}'),
    ]);
    expect(r.html('notes/a/index.html')).toBe('https://demo.example/notes/a/ https://demo.example/notes/share.png');
    expect(r.html('notes/b/index.html')).toBe('https://demo.example/notes/b/ https://demo.example/notes/cover.png');
    expect(r.html('notes/c/index.html')).toBe('https://demo.example/notes/c/ https://demo.example/img/hero.png');
    expect(r.html('notes/d/index.html')).toBe('https://demo.example/notes/d/ ');
  });

  it('adds Open Graph tags in the default theme', () => {
    const r = build([{ path: 'a.md', content: '---\ntitle: Alpha\ndescription: About alpha.\ncover: c.png\ndate: 2026-01-01\n---\nBody' }]);
    const html = r.html('a/index.html');
    expect(html).toContain('<meta property="og:url" content="https://demo.example/a/">');
    expect(html).toContain('<meta property="og:image" content="https://demo.example/c.png">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });
});

describe('front matter access (R89)', () => {
  it('reports a page marked private that the rules make public, as a refusal', () => {
    const r = build([{ path: 'a.md', content: '---\naccess: private\n---\nBody' }]);
    expect(r.kinds).toContain('access-private-made-public');
    expect(REFUSING.has('access-private-made-public')).toBe(true);
    expect(r.pages.find((p) => p.path === 'a/index.html')?.tier).toBe('public');
  });

  it('never makes a page public because its front matter says so', () => {
    const r = build([{ path: 'a.md', content: '---\naccess: public\n---\nBody' }], { rules: [] });
    expect(r.pages.find((p) => p.path === 'a/index.html')?.tier).toBe('private');
    expect(r.kinds).toContain('access-public-kept-private');
    expect(REFUSING.has('access-public-kept-private')).toBe(false);
  });
});
