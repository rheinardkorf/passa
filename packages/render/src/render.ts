// Renders a site's Markdown sources to pages (M3). Pure: sources in, pages
// out, no I/O, so Passa's publish step and the passa command share it.
import { createHash } from 'node:crypto';
import Mustache from 'mustache';
import { CARD_FONT } from './cards.ts';
import { parse as parseYaml } from 'yaml';
import { inlineLambda, markdownFor, pageState, type PageState } from './markdown.ts';
import { DEFAULT_CARD, DEFAULT_LAYOUTS } from './theme.ts';
import { baseOf, dirOf, escapeHtml, outputOf, resolveFrom, slugify } from './text.ts';

// Template values are escaped for HTML text and quoted attributes; / is left as is.
Mustache.escape = (value: unknown) => escapeHtml(String(value));

export const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs';

export type Source = { path: string; content: string };
export type Rule = { path: string; tier: string };

export type RenderInput = {
  sources: Source[];
  // Access rules, as set_access stores them (any tiers).
  rules?: Rule[];
  // The site's address, for the feed's absolute links.
  siteUrl: string;
  siteTitle?: string;
  // Plain files in the version, to find pages that would replace one (R68).
  files?: string[];
  // Social cards for public pages (R94–R97), given each plain file's content
  // hash, so a card's name changes whenever its fonts or images do.
  cards?: { fileHash: (path: string) => string | undefined };
};

// A public page's social card: its HTML for drawCard, the site paths of the
// images it embeds, and where it's served (beside the page, named by the hash
// of everything that draws it). Cards with the same hash are the same image.
export type Card = { path: string; hash: string; html: string; images: string[] };

export type ProblemKind =
  | 'conflict' // R68: a page would replace a plain file
  | 'layout' // R79: a page names a layout that doesn't exist
  | 'access-private-made-public' // R89: front matter says private, the rules make it public
  | 'access-public-kept-private' // R89: front matter says public, the rules keep it private
  | 'missing-link' // R73
  | 'widget' // R76: invalid widget data
  | 'front-matter'
  | 'site-settings'
  | 'template'
  | 'card'; // R95, R96: a card names an image that isn't the site's own, or has no fonts

export type Problem = { kind: ProblemKind; source: string | null; message: string };

// Problems that refuse a publish in Passa; access-private-made-public refuses
// only until the change is confirmed with confirm_public.
export const REFUSING: ReadonlySet<ProblemKind> = new Set(['conflict', 'layout', 'access-private-made-public', 'card']);

// The files a site renders from (R86): Markdown, layouts and the site's settings.
export const isSource = (path: string) =>
  (path.endsWith('.md') && !path.startsWith('_layouts/')) || (path.startsWith('_layouts/') && path.endsWith('.html')) || path === '_site.yml';

// The read-only copy of a site's rules that each version with sources carries
// (R88), so a folder taken out of Passa knows what's public.
export const RULES_FILE = '_passa/access.yml';
export const rulesFile = (rules: Rule[]) => '# Written by Passa on every publish: the site\'s access rules. Editing this changes nothing; use set_access.\n'
  + (rules.length ? rules.map((r) => `- { path: ${JSON.stringify(r.path)}, tier: ${JSON.stringify(r.tier)} }\n`).join('') : '[]\n');

export type RenderedPage ={ path: string; html: string; from: string | null; tier: string };

// cards and cardFonts only with input.cards; cardFonts are the theme's font
// paths, or empty for the default card's built-in fonts.
export type RenderResult = { pages: RenderedPage[]; feed?: string; problems: Problem[]; cards?: Card[]; cardFonts?: string[] };

// Changes when the default card or how cards are drawn changes, so every card is drawn again.
const CARD_FORMAT = 'passa-card-1';
// The served name of a card: _card-<hash>.png in its page's folder.
export const CARD_FILE = /^_card-([0-9a-f]{20})\.png$/;

// The tier for a served path: the longest matching rule, else private (as shared/rules.ts).
const tierFor = (rules: Rule[], servedPath: string) =>
  [...rules].sort((a, b) => b.path.length - a.path.length).find((r) => servedPath.startsWith(r.path))?.tier ?? 'private';

// Who sees what, the one rule for lists, backlinks and tag pages (R82): a page's
// visitors see public pages and pages of the page's own tier; owner-only
// (private) pages see everything. No other tier includes another.
const sees = (viewerTier: string, item: { tier: string }) => viewerTier === 'private' || item.tier === 'public' || item.tier === viewerTier;

type FrontMatter = Record<string, unknown>;

// A Markdown source's front matter and body, and why the front matter can't be
// read when it can't. The passa command uses it too, to decide access the same way.
export function splitFrontMatter(content: string): { data: FrontMatter; body: string; problem?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);
  if (!m) return { data: {}, body: content };
  try {
    const data: unknown = parseYaml(m[1] ?? '') ?? {};
    return { data: data && typeof data === 'object' && !Array.isArray(data) ? (data as FrontMatter) : {}, body: content.slice(m[0].length) };
  } catch (err) {
    // The usual cause: a value with ": " in it, which YAML reads as a nested key.
    const hint = /mapping/i.test(firstLine(err)) ? '. A value containing ": " needs quotes, such as description: "One: two"' : '';
    return { data: {}, body: content, problem: `front matter isn't valid YAML (${firstLine(err)})${hint}` };
  }
}

const firstLine = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';

const isoDate = (value: unknown) => {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

// Prose words: fenced blocks and link reference definitions don't count.
const proseWords = (body: string) =>
  body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/^ {0,3}\[[^\]\n]+\]:.*$/gm, '').split(/\s+/).filter(Boolean).length;

type Page = {
  source: string | null;
  dir: string;
  file: string;
  url: string;
  data: FrontMatter;
  body: string;
  tier: string;
  date: string | undefined;
  unlisted: boolean;
  words: number;
  tags: string[];
  state: PageState;
  generated?: 'index' | 'tag';
  tag?: string;
  title: string;
  content: string;
  kind: string;
  cover: string | undefined;
  excerpt: string;
  backlinks: Page[];
};

type Summary = Record<string, unknown> & { year?: string | undefined };

// A getter that builds its value the first time a template asks for it, so
// pages whose layout never lists every page don't pay for those lists.
function lazy(obj: object, name: string, make: () => unknown) {
  let value: unknown;
  let made = false;
  Object.defineProperty(obj, name, { enumerable: true, get: () => (made ? value : ((made = true), (value = make()))) });
}

// Positions for a plain list: index (from 1), isFirst, isLast.
const pad = (n: number) => String(n).padStart(2, '0');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const positions = <T extends object>(list: T[]) => list.map((item, i) => ({ ...item, index: i + 1, indexPadded: pad(i + 1), isFirst: i === 0, isLast: i === list.length - 1 }));

// Page lists: each item inherits from the shared summary, so lists stay cheap
// per page. `from` is the first item's index, so `rest` continues `featured`.
const placed = (list: Summary[], from = 1) =>
  list.map((item, i) => Object.assign(Object.create(item) as Summary, { index: i + from, indexPadded: pad(i + from), isFirst: i + from === 1, isLast: i === list.length - 1 }));

export function render(input: RenderInput): RenderResult {
  const { sources, rules = [], siteUrl, siteTitle = 'Site', files = [] } = input;
  const problems: Problem[] = [];
  const problem = (kind: ProblemKind, source: string | null, message: string) => problems.push({ kind, source, message });

  const layouts = new Map<string, string>();
  const partials: Record<string, string> = {};
  const widgets = new Map<string, string>();
  for (const s of sources.filter((x) => x.path.startsWith('_layouts/') && x.path.endsWith('.html'))) {
    const name = s.path.slice('_layouts/'.length, -'.html'.length);
    if (name.startsWith('partials/')) partials[name.slice('partials/'.length)] = s.content;
    else if (name.startsWith('widgets/')) widgets.set(name.slice('widgets/'.length), s.content);
    else layouts.set(name, s.content);
  }
  // The card is a template, not a layout a page can use.
  const themeCard = layouts.get('card');
  layouts.delete('card');
  const cardTemplate = themeCard ?? DEFAULT_CARD;
  const cardFonts = themeCard ? files.filter((f) => CARD_FONT.test(f)).sort() : [];
  const cardHashes = input.cards;
  let cardKey = CARD_FORMAT;
  if (cardHashes) {
    if (themeCard && !cardFonts.length) problem('card', '_layouts/card.html', '_layouts/card.html needs fonts: add .woff or .ttf files as _layouts/fonts/Family__weight__style.woff');
    cardKey += cardFonts.map((f) => `\n${f}=${cardHashes.fileHash(f) ?? ''}`).join('') + (themeCard ? '' : `\n${DEFAULT_CARD}`);
  }
  const cards: Card[] = [];

  // Site settings: _site.yml (title, description, author, nav, locale, and anything else).
  let siteData: FrontMatter = {};
  const siteSource = sources.find((x) => x.path === '_site.yml');
  if (siteSource) {
    try {
      const parsed: unknown = parseYaml(siteSource.content) ?? {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) siteData = parsed as FrontMatter;
    } catch (err) {
      problem('site-settings', '_site.yml', `_site.yml isn't valid YAML (${firstLine(err)})`);
    }
  }
  const navItems = (Array.isArray(siteData.nav) ? siteData.nav : []).filter(isRecord);
  // Every link in the nav, sections included, in order: for navPrev and navNext.
  const readingOrder: { title: unknown; url: string }[] = [];
  const read = (items: Record<string, unknown>[]) => {
    for (const n of items) {
      if (typeof n.url === 'string' && !readingOrder.some((l) => l.url === n.url)) readingOrder.push({ title: n.title, url: n.url });
      if (Array.isArray(n.items)) read(n.items.filter(isRecord));
    }
  };
  read(navItems);
  const site: FrontMatter & { title: string; url: string; nav: Record<string, unknown>[] } = {
    ...siteData, title: typeof siteData.title === 'string' ? siteData.title : siteTitle, url: siteUrl, nav: navItems,
  };

  // Pages, before rendering, so links can resolve to any of them.
  const pages: Page[] = [];
  for (const s of sources.filter((x) => /\.md$/i.test(x.path) && !x.path.startsWith('_layouts/'))) {
    const { data, body, problem: fm } = splitFrontMatter(s.content);
    if (fm) problem('front-matter', s.path, fm);
    if (data.draft === true) continue;
    const out = outputOf(s.path);
    const tags = Array.isArray(data.tags) ? data.tags.map(String) : data.tags ? [String(data.tags)] : [];
    pages.push({
      source: s.path, dir: dirOf(s.path), body, data, ...out,
      tier: tierFor(rules, `${out.url}index.html`),
      date: isoDate(data.date),
      unlisted: data.hidden === true || data.unlisted === true,
      words: proseWords(body),
      tags,
      state: pageState(s.path, dirOf(s.path)),
      title: '', content: '', kind: '', cover: undefined, excerpt: '', backlinks: [],
    });
  }

  // Pages that would replace a plain file (R68).
  const taken = new Set(files.map((f) => f.toLowerCase()));
  const rendersTo = new Map<string, string>();
  for (const p of pages) {
    const file = p.file.toLowerCase();
    if (taken.has(file)) problem('conflict', p.source, `${p.source} renders to ${p.file}, which is already a file in the site`);
    else if (rendersTo.has(file)) problem('conflict', p.source, `${p.source} and ${rendersTo.get(file)} both render to ${p.file}`);
    else rendersTo.set(file, p.source ?? '');
  }

  // Front matter access never grants access (R89), but disagreements are reported.
  // Pages kept private are one warning, however many: a site published private
  // with pages meant to be public would otherwise warn once per page.
  const keptPrivate: Page[] = [];
  for (const p of pages) {
    const said = typeof p.data.access === 'string' ? p.data.access.toLowerCase() : undefined;
    if (said === 'private' && p.tier === 'public') problem('access-private-made-public', p.source, `${p.source} says access: private, but the site's rules make ${p.url} public`);
    if (said === 'public' && p.tier !== 'public') keptPrivate.push(p);
  }
  const [only] = keptPrivate;
  if (only && keptPrivate.length === 1) problem('access-public-kept-private', only.source, `${only.source} says access: public, but the site's rules keep ${only.url} ${only.tier}`);
  else if (keptPrivate.length > 1) {
    const named = keptPrivate.slice(0, 5).map((p) => p.source).join(', ');
    const more = keptPrivate.length > 5 ? ` and ${keptPrivate.length - 5} more` : '';
    problem('access-public-kept-private', null, `${keptPrivate.length} pages say access: public, but the site's rules keep them private (${named}${more}). Front matter never makes a page public: change the site's rules to.`);
  }

  // Link resolution: by path, by file name, or by title, ignoring case and punctuation (R73).
  const byKey = new Map<string, Page>();
  const key = (s: string) => slugify(s.replace(/\.md$/i, ''));
  for (const p of pages) {
    const keys = [key(p.source ?? ''), key(baseOf(p.source ?? '')), typeof p.data.title === 'string' ? key(p.data.title) : null];
    for (const k of keys) if (k && !byKey.has(k)) byKey.set(k, p);
  }
  const resolve = (target: string, from?: string) => {
    if (!target) return undefined;
    // A relative link: only the folder-resolved path counts, so plain asset links aren't hijacked.
    const found = from ? byKey.get(key(resolveFrom(dirOf(from), target).slice(1))) : byKey.get(key(target));
    return found?.source ? { source: found.source, url: found.url } : undefined;
  };

  const md = markdownFor({ resolve, widgets, partials, site });
  const resolveAsset = (dir: string, value: string) => (/^([a-z]+:|\/)/i.test(value) ? value : resolveFrom(dir, value));
  for (const p of pages) {
    p.content = md.render(p.body, { page: p.state });
    for (const message of p.state.problems) problem('widget', p.source, message);
    for (const target of p.state.missing) problem('missing-link', p.source, `[[${target}]] doesn't match any page`);
    p.title = String(p.data.title ?? p.state.firstHeading ?? baseOf(p.source ?? ''));
    // Front matter `kind` wins; a deck is a deck; otherwise essay or note by length.
    p.kind = p.data.kind ? slugify(String(p.data.kind)) : p.data.layout === 'deck' ? 'deck' : p.words < 350 ? 'note' : 'essay';
    p.cover = p.data.cover ? resolveAsset(p.dir, String(p.data.cover)) : undefined;
    const excerpt = String(p.data.description ?? p.data.seoDescription ?? p.state.excerpt ?? '');
    p.excerpt = excerpt.length > 220 ? `${excerpt.slice(0, 217).replace(/\s+\S*$/, '')}…` : excerpt;
  }

  // Backlinks.
  const bySource = new Map(pages.map((p) => [p.source, p]));
  for (const p of pages) for (const target of p.state.links) bySource.get(target)?.backlinks.push(p);

  // Listed pages, newest first. The home page is never in a list (R82).
  const sorted = pages.filter((q) => !q.unlisted && q.url !== '/').sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title));

  // Per tier, once: the pages its visitors can see, indexed for prev/next,
  // related and tag pages.
  type TierIndex = { list: Page[]; dated: Page[]; at: Map<Page, number>; order: Map<Page, number>; byTag: Map<string, Page[]> };
  const tiers = new Map<string, TierIndex>();
  const forTier = (tier: string): TierIndex => {
    const known = tiers.get(tier);
    if (known) return known;
    const list = sorted.filter((q) => sees(tier, q));
    const dated = list.filter((q) => q.date);
    const byTag = new Map<string, Page[]>();
    for (const q of list) {
      for (const t of q.tags) {
        const tagged = byTag.get(t);
        if (tagged) tagged.push(q);
        else byTag.set(t, [q]);
      }
    }
    const index = { list, dated, at: new Map(dated.map((q, i) => [q, i])), order: new Map(list.map((q, i) => [q, i])), byTag };
    tiers.set(tier, index);
    return index;
  };

  // A tag has a page only if that page's own visitors can see a listed page
  // with the tag (R83). Tags with no page (say, used only on hidden pages)
  // get a null url (never a missing one, which Mustache would fill from the
  // page around it), so nothing links to a page that doesn't exist.
  const tagUrl = (t: string) => `/tags/${slugify(t)}/`;
  const tagPages = new Map<string, boolean>();
  const hasTagPage = (t: string) => {
    let has = tagPages.get(t);
    // A plain file at the tag page's path wins: the tag then has no page.
    const file = `${tagUrl(t)}index.html`;
    if (has === undefined) tagPages.set(t, (has = !taken.has(file.slice(1).toLowerCase()) && forTier(tierFor(rules, file)).byTag.has(t)));
    return has;
  };
  const tagLink = (t: string) => (hasTagPage(t) ? { name: t, url: tagUrl(t), hasPage: true } : { name: t, url: null, hasPage: false });

  // Dates in the site's language, as a date (no time zone shifts).
  const locale = String(site.locale ?? 'en-GB');
  const long = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
  const short = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  const summary = (p: Page): Summary => ({
    title: p.title, url: p.url, date: p.date, dateText: p.date?.slice(0, 10), year: p.date?.slice(0, 4),
    dateLong: p.date ? long.format(new Date(p.date)) : undefined,
    dateShort: p.date ? short.format(new Date(p.date)) : undefined,
    description: p.data.description ?? p.data.seoDescription, excerpt: p.excerpt,
    readingTime: Math.max(1, Math.round(p.words / 230)), words: p.words, kind: p.kind,
    isNote: p.kind === 'note', isEssay: p.kind === 'essay', isDeck: p.kind === 'deck', cover: p.cover, accent: p.data.accent,
    author: p.data.author ?? site.author,
    tags: positions(p.tags.map(tagLink)),
  });
  const summaries = new Map(pages.map((p) => [p, summary(p)]));
  const summaryOf = (p: Page) => summaries.get(p) ?? summary(p);
  const recentCount = Number.isInteger(site.recentCount) && Number(site.recentCount) > 0 ? Number(site.recentCount) : 5;

  // A tier's tags with counts and pages, once per tier, the first time a layout asks.
  const tierTags = new Map<string, Summary[]>();
  const tagsFor = (tier: string) => {
    const known = tierTags.get(tier);
    if (known) return known;
    const { byTag } = forTier(tier);
    const tags = placed([...byTag.keys()].sort((a, b) => a.localeCompare(b)).map((t) => {
      const tagged = byTag.get(t) ?? [];
      return { ...tagLink(t), count: tagged.length, one: tagged.length === 1, pages: placed(tagged.map(summaryOf)) };
    }));
    tierTags.set(tier, tags);
    return tags;
  };

  // A generated home page when the site has none (R83), and a page per tag. A
  // tag page exists only if its own visitors can see a page with that tag, so
  // a tag used only on private pages never gets a public page naming it.
  const generatedPage = (file: string, url: string, title: string, tier: string, generated: 'index' | 'tag', tag?: string): Page => ({
    source: null, dir: '', file, url, data: {}, body: '', tier, date: undefined, unlisted: true, words: 0, tags: [],
    state: pageState(null, ''), generated, ...(tag === undefined ? {} : { tag }), title, content: '', kind: '', cover: undefined, excerpt: '', backlinks: [],
  });
  if (!pages.some((p) => p.file === 'index.html') && !taken.has('index.html')) pages.push(generatedPage('index.html', '/', site.title, tierFor(rules, '/index.html'), 'index'));
  for (const t of [...new Set(sorted.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b))) {
    const url = tagUrl(t);
    if (hasTagPage(t)) pages.push(generatedPage(`${url.slice(1)}index.html`, url, t, tierFor(rules, `${url}index.html`), 'tag', t));
  }

  // A card's images must be the site's own files, named by path; its hash covers
  // its HTML, those images, and the fonts (R96, R97).
  const cardFor = (url: string, source: string, html: string): Card | undefined => {
    if (!cardHashes) return undefined;
    const images: string[] = [];
    let bad = false;
    const resolved = html.replace(/(<img\b[^>]*\ssrc=")([^"]*)(")/g, (whole, before: string, src: string, after: string) => {
      if (src.startsWith('data:')) return whole;
      if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) {
        problem('card', source, `the card for ${source} names ${src}: cards can only use the site's own images`);
        bad = true;
        return whole;
      }
      const path = decodeURIComponent(new URL(src, `https://card.invalid${url}`).pathname).slice(1);
      if (!cardHashes.fileHash(path)) {
        problem('card', source, `the card for ${source} names ${src}, which isn't a file in the site`);
        bad = true;
        return whole;
      }
      images.push(path);
      return `${before}/${path}${after}`;
    });
    if (bad) return undefined;
    const key = [cardKey, resolved, ...[...new Set(images)].sort().map((i) => `${i}=${cardHashes.fileHash(i) ?? ''}`)].join('\n');
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 20);
    return { path: `${url.slice(1)}_card-${hash}.png`, hash, html: resolved, images: [...new Set(images)] };
  };

  // Feed (R84): public, dated, listed pages only, newest first. A site's own
  // feed.xml wins over the generated one. Layouts get its URL as `feed`, so
  // they only link to a feed that exists.
  const feedItems = pages.filter((p) => p.date && p.tier === 'public' && !p.unlisted && !p.generated && p.url !== '/')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 50);
  const feed = feedItems.length || taken.has('feed.xml') ? '/feed.xml' : null;

  const out: RenderedPage[] = [];
  for (const p of pages) {
    const layoutName = p.data.layout ? String(p.data.layout)
      : p.url === '/' && layouts.has('home') ? 'home'
      : p.generated === 'index' ? (layouts.has('index') ? 'index' : 'default')
      : p.generated === 'tag' ? (layouts.has('tag') ? 'tag' : 'default')
      : layouts.has(p.kind) ? p.kind : 'default';
    const layout = layouts.get(layoutName) ?? DEFAULT_LAYOUTS[layoutName];
    if (!layout) {
      problem('layout', p.source, `${p.source} uses layout ${layoutName}, which isn't in _layouts/`);
      continue;
    }
    const { list: visible, dated, at: datedAt, order, byTag } = forTier(p.tier);
    // This page's list: on a tag page, that tag's pages; elsewhere, the other listed pages.
    const source = p.generated === 'tag' ? byTag.get(p.tag ?? '') ?? [] : visible;
    let all: Summary[] | undefined;
    const list = () => (all ??= source.filter((q) => q !== p).map(summaryOf));
    // The first n of the list, without building all of it.
    const first = (n: number) => {
      if (all) return all.slice(0, n);
      const items: Summary[] = [];
      for (const q of source) {
        if (items.length >= n) break;
        if (q !== p) items.push(summaryOf(q));
      }
      return items;
    };
    const count = source.length - (source === visible && !p.generated && !p.unlisted && p.url !== '/' ? 1 : 0);
    const at = datedAt.get(p) ?? -1;
    // Up to three pages sharing the most tags (newest first on a tie), found
    // through the tag index. With one tag, every candidate ties.
    const related = (): Summary[] => {
      if (p.generated || !p.tags.length) return [];
      if (p.tags.length === 1) return (byTag.get(p.tags[0] ?? '') ?? []).filter((q) => q !== p).slice(0, 3).map(summaryOf);
      const shared = new Map<Page, number>();
      for (const t of p.tags) for (const q of byTag.get(t) ?? []) if (q !== p) shared.set(q, (shared.get(q) ?? 0) + 1);
      const best: [Page, number][] = [];
      const before = (a: [Page, number], b: [Page, number]) => a[1] > b[1] || (a[1] === b[1] && (order.get(a[0]) ?? 0) < (order.get(b[0]) ?? 0));
      for (const entry of shared) {
        const last = best[2];
        if (last && !before(entry, last)) continue;
        const slot = best.findIndex((b) => before(entry, b));
        best.splice(slot === -1 ? best.length : slot, 0, entry);
        if (best.length > 3) best.pop();
      }
      return best.map(([q]) => summaryOf(q));
    };
    // Nav items know whether they lead to this page or the section it's in;
    // a link to / is current only on the home page. An item with its own
    // items is a section, current when one of them is.
    const leads = (url: unknown) => typeof url === 'string' && (url === p.url || (url !== '/' && p.url.startsWith(url)));
    const navTree = (items: Record<string, unknown>[]): Record<string, unknown>[] => positions(items.map((n) => {
      const children = Array.isArray(n.items) ? navTree(n.items.filter(isRecord)) : undefined;
      return { ...n, ...(children ? { items: children } : {}), current: leads(n.url) || !!children?.some((c) => c.current) };
    }));
    const nav = navTree(site.nav);
    const reading = readingOrder.findIndex((l) => l.url === p.url);
    const older = at >= 0 ? dated[at + 1] : undefined;
    const newer = at > 0 ? dated[at - 1] : undefined;
    const prev = older ? summaryOf(older) : null;
    const next = newer ? summaryOf(newer) : null;
    const heroData = p.data.hero;
    const hero = heroData && typeof heroData === 'object' && !Array.isArray(heroData)
      ? { ...heroData, ...('image' in heroData && heroData.image ? { image: resolveAsset(p.dir, String(heroData.image)) } : {}) } : undefined;
    // A hero is the page's opening, so it replaces a leading # Heading: the
    // heading leaves the content, and the hero (or the title) is shown instead.
    const content = hero && p.state.startsWithHeading ? p.content.replace(/^<h1[^>]*>[\s\S]*?<\/h1>\n?/, '') : p.content;
    // Absolute URLs, for Open Graph tags and feeds; they follow the site's name (R84).
    const absolute = (url: string) => new URL(url, siteUrl).href;
    const socialSource = p.data.socialImage ? resolveAsset(p.dir, String(p.data.socialImage)) : p.cover ?? (typeof hero?.image === 'string' ? hero.image : undefined);
    // The page's own values. Also under `page`, which list items and widget
    // data never shadow: {{page.title}} works inside {{#pages}} or {{#hero}}.
    const self: Record<string, unknown> = {
      ...p.data,
      ...(p.generated ? {} : summaryOf(p)),
      title: p.title,
      url: p.url,
      absoluteUrl: absolute(p.url),
      socialImage: socialSource ? absolute(socialSource) : null,
      hero,
      isHome: p.url === '/',
      isIndex: p.generated === 'index',
      isTag: p.generated === 'tag',
      isPage: !p.generated,
      tag: p.tag,
      // The layout shows the title when the page doesn't start with its own.
      showTitle: !p.generated && !p.state.startsWithHeading && p.data.hideTitle !== true,
      toc: positions(p.state.toc),
      hasToc: p.state.toc.length >= 3,
    };
    const featured = first(1)[0];
    const view: Record<string, unknown> = {
      ...self,
      page: self,
      content,
      backlinks: placed(p.backlinks.filter((b) => sees(p.tier, b)).map(summaryOf)),
      prev,
      next,
      hasPager: !!(prev || next),
      pageCount: count,
      onePage: count === 1,
      featured: featured ? placed([featured])[0] : null,
      recent: placed(first(recentCount)),
      site: { ...site, nav },
      nav,
      // The pages before and after this one in the nav's reading order.
      navPrev: reading > 0 ? readingOrder[reading - 1] : null,
      navNext: reading >= 0 ? readingOrder[reading + 1] ?? null : null,
      lang: String(site.lang ?? site.locale ?? 'en'),
      mermaid: p.state.mermaid ? MERMAID : null,
      feed,
      // {{#markdown}}{{hero.text}}{{/markdown}}: a value as inline Markdown.
      markdown: inlineLambda(md, { page: pageState(p.source, p.dir) }),
    };
    lazy(view, 'allTags', () => tagsFor(p.tier));
    lazy(view, 'related', () => placed(related()));
    lazy(view, 'pages', () => placed(list()));
    lazy(view, 'rest', () => placed(list().slice(1), 2));
    lazy(view, 'years', () => {
      const years: { year: string; isUndated: boolean; pages: Summary[] }[] = [];
      for (const item of list()) {
        const year = item.year ?? String(site.undated ?? 'Undated');
        const last = years.at(-1);
        if (last?.year === year) last.pages.push(item);
        else years.push({ year, isUndated: !item.year, pages: [item] });
      }
      return positions(years.map((y) => ({ ...y, count: y.pages.length, one: y.pages.length === 1, pages: placed(y.pages) })));
    });
    // The content split at each thematic break (--- with a blank line above),
    // for slides or sectioned layouts.
    let sections: { content: string }[] | undefined;
    const splitSections = () => (sections ??= content.split(/^<hr>\n/m).filter((c) => c.trim()).map((part) => ({ content: part })));
    lazy(view, 'sections', () => positions(splitSections()));
    lazy(view, 'sectionCount', () => splitSections().length);
    try {
      // A public page without its own social image gets a card (R94, R95):
      // crawlers can't sign in, so private pages get none.
      if (cardHashes && p.tier === 'public' && !p.data.socialImage) {
        const card = cardFor(p.url, p.source ?? p.file, Mustache.render(cardTemplate, view, partials));
        if (card) {
          cards.push(card);
          self.socialImage = view.socialImage = absolute(`${p.url}_card-${card.hash}.png`);
        }
      }
      out.push({ path: p.file, html: Mustache.render(layout, view, partials), from: p.source, tier: p.tier });
    } catch (err) {
      problem('template', p.source, `${p.source ?? p.file}: layout ${layoutName} failed (${firstLine(err)})`);
    }
  }

  const result: RenderResult = { pages: out, problems, ...(cardHashes ? { cards, cardFonts } : {}) };
  if (feedItems.length && !taken.has('feed.xml')) {
    const abs = (url: string) => new URL(url, siteUrl).href;
    result.feed = `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0"><channel><title>${escapeHtml(site.title)}</title><link>${abs('/')}</link><description>${escapeHtml(String(site.description ?? site.title))}</description>\n`
      + feedItems.map((p) => `<item><title>${escapeHtml(p.title)}</title><link>${abs(p.url)}</link><guid>${abs(p.url)}</guid><pubDate>${new Date(p.date ?? 0).toUTCString()}</pubDate>${p.excerpt ? `<description>${escapeHtml(p.excerpt)}</description>` : ''}</item>`).join('\n')
      + '\n</channel></rss>\n';
  }
  return result;
}
