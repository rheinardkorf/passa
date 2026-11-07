// The Markdown pipeline (R72–R77): markdown-it with footnotes, plus Passa's own
// small rules for wikilinks, callouts, task lists, heading anchors, relative
// links and widgets. A fixed set: no plugins, no publisher code.
import MarkdownIt from 'markdown-it';
import type { MarkdownIt as Markdown, StateCore, StateInline, Token } from 'markdown-it';
import footnote from 'markdown-it-footnote';
import hljs from 'highlight.js/lib/core';
import Mustache from 'mustache';
import { parse as parseYaml } from 'yaml';
import { languages } from './languages.ts';
import { DEFAULT_WIDGETS, chartSvg, parseOptions, widgetShapeProblem } from './widgets.ts';
import { escapeHtml, resolveFrom, slugify } from './text.ts';

for (const [name, lang] of Object.entries(languages)) hljs.registerLanguage(name, lang);
hljs.registerAliases(['sh', 'zsh'], { languageName: 'bash' });
hljs.registerAliases(['js', 'jsx', 'mjs'], { languageName: 'javascript' });
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
hljs.registerAliases(['html', 'svg'], { languageName: 'xml' });
hljs.registerAliases(['yml'], { languageName: 'yaml' });

// What rendering one page collects as it goes.
export type PageState = {
  source: string | null;
  dir: string;
  links: Set<string>;
  missing: string[];
  ids: Set<string>;
  toc: { id: string; text: string; level: number }[];
  problems: string[];
  firstHeading?: string;
  // True when the body's first block is a # heading.
  startsWithHeading?: boolean;
  excerpt?: string;
  mermaid: boolean;
  // True when the page embeds a fragment, so its layout loads HTMX.
  embeds: boolean;
  // Embeds render refuses (M7 R172): a missing src, or one that isn't a fragment.
  badEmbeds: string[];
};

export const pageState = (source: string | null, dir: string): PageState => ({
  source, dir, links: new Set(), missing: [], ids: new Set(), toc: [], problems: [], mermaid: false, embeds: false, badEmbeds: [],
});

export type Env = { page: PageState };

export type MarkdownContext = {
  // Resolves a link target to a page: by path, file name or title; `from` makes
  // it a relative link from that source.
  resolve: (target: string, from?: string) => { source: string; url: string } | undefined;
  // Resolves an embed's src to a fragment's URL and its rule's mark (M6 R167),
  // or says why it can't be embedded.
  embed: (target: string) => { url: string; mark?: string | undefined } | { problem: string };
  widgets: Map<string, string>;
  partials: Record<string, string>;
  site: Record<string, unknown>;
};

// A Mustache lambda: {{#markdown}}{{text}}{{/markdown}} renders a value as inline Markdown.
export const inlineLambda = (md: Markdown, env: Env) => () => (text: string, render: (t: string) => string) => md.renderInline(render(text), env);

const textOf = (tokens: Token[] | null) => (tokens ?? []).filter((c) => c.type === 'text' || c.type === 'code_inline').map((c) => c.content).join('');
// How an embed loads: when the page does, when it's scrolled into view, or on a click.
const TRIGGERS = ['load', 'revealed', 'click'];
// An embed's own classes, for themes: plain class names, space-separated.
const CLASSES = /^-?[A-Za-z_][\w-]*(?: +-?[A-Za-z_][\w-]*)*$/;

const isAbsolute = (href: string) => /^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(href);

export function markdownFor(ctx: MarkdownContext): Markdown {
  const md: Markdown = MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        const name = escapeHtml(lang);
        return `<pre class="hljs" data-lang="${name}"><code class="language-${name}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      }
      return '';
    },
  }).use(footnote);

  // Widgets (R76, R77): a fence named after a built-in widget or one of the
  // theme's renders through its template. Any other name stays a code block.
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, rawEnv, self) => {
    const env = rawEnv as Env;
    const token = tokens[idx];
    const fallback = () => (fence ? fence(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options));
    if (!token) return '';
    const info = token.info.trim();
    const name = info.split(/\s+/)[0] ?? '';
    if (name === 'fragment') return embed(token.content, env);
    const template = ctx.widgets.get(name) ?? DEFAULT_WIDGETS[name];
    if (!template) return fallback();
    const content = token.content;
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    let data: Record<string, unknown>;
    try {
      if (name === 'mermaid') {
        // Left as text for the client-side script, which the page loads only if it has one.
        env.page.mermaid = true;
        data = { code: content };
      } else if (name === 'gallery') {
        // One image per line, ![caption](path).
        data = {
          items: lines.flatMap((l) => {
            const m = /^!\[([^\]]*)\]\(([^)\s]+)/.exec(l);
            return m ? [{ alt: m[1] ?? '', src: isAbsolute(m[2] ?? '') ? m[2] : resolveFrom(env.page.dir, m[2] ?? '') }] : [];
          }),
        };
      } else if (name === 'timeline') {
        // One entry per line, "when: what" (what is inline Markdown).
        data = {
          items: lines.flatMap((l) => {
            const m = /^([^:]+):\s*(.+)$/.exec(l);
            return m ? [{ when: (m[1] ?? '').trim(), what: md.renderInline(m[2] ?? '', env) }] : [];
          }),
        };
      } else {
        // Everything else is YAML: a list becomes `items`, a map its own fields.
        const parsed: unknown = parseYaml(content) ?? {};
        data = Array.isArray(parsed) ? { items: parsed } : typeof parsed === 'object' && parsed ? { ...parsed } : { text: String(parsed) };
        if (name === 'chart') data.svg = chartSvg(data);
      }
      const shape = ctx.widgets.has(name) ? undefined : widgetShapeProblem(name, data, lines);
      if (shape) throw new Error(shape);
      // List items that are maps know their place, like page lists.
      if (Array.isArray(data.items)) {
        const items: unknown[] = data.items;
        data.items = items.map((item, i) => (item && typeof item === 'object' ? { ...item, index: i + 1, isFirst: i === 0, isLast: i === items.length - 1 } : item));
      }
      return `${Mustache.render(template, { ...data, options: parseOptions(info.slice(name.length)), site: ctx.site, markdown: inlineLambda(md, env) }, ctx.partials)}\n`;
    } catch (err) {
      env.page.problems.push(`${name} block: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
      return fallback();
    }
  };

  // An embed (M7 R171): a placeholder HTMX fills with a fragment, showing its
  // fallback until then, and for viewers the fragment's rule doesn't open. The
  // placeholder stays, with its classes; the fragment goes inside it.
  // It isn't a link: a page may embed what some of its readers can't open.
  const embed = (content: string, env: Env) => {
    const refuse = (why: string) => {
      env.page.badEmbeds.push(why);
      return '';
    };
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = parseYaml(content) ?? {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return refuse('a fragment block needs src: [[page]]');
      data = parsed as Record<string, unknown>;
    } catch (err) {
      return refuse(`a fragment block isn't valid YAML (${(err instanceof Error ? err.message : String(err)).split('\n')[0]})`);
    }
    // Unquoted, YAML reads src: [[page]] as a list in a list.
    const raw = Array.isArray(data.src) && Array.isArray(data.src[0]) ? data.src[0][0] : data.src;
    const src = typeof raw === 'string' ? raw.trim().replace(/^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/, '$1').trim() : '';
    if (!src) return refuse('a fragment block needs src: [[page]]');
    const trigger = data.trigger === undefined ? 'load' : String(data.trigger);
    if (!TRIGGERS.includes(trigger)) return refuse(`a fragment block's trigger is ${TRIGGERS.join(', ')}, not ${trigger}`);
    const classes = data.class === undefined ? '' : String(data.class).trim();
    if (classes && !CLASSES.test(classes)) return refuse(`a fragment block's class is class names separated by spaces, not ${classes}`);
    const found = ctx.embed(src);
    if ('problem' in found) return refuse(found.problem);
    env.page.embeds = true;
    const fallback = data.fallback === undefined ? '' : md.render(String(data.fallback), env);
    const mark = found.mark ? ` data-passa-rule="${found.mark}"` : '';
    return `<div class="passa-embed${classes ? ` ${classes}` : ''}" hx-get="${escapeHtml(found.url)}" hx-trigger="${trigger}" hx-swap="innerHTML"${mark}>${fallback}</div>\n`;
  };

  // Wikilinks: [[target]] and [[target|text]], before link parsing, so Foam's
  // generated link references don't turn them into [link] with brackets.
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const m = /^\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const target = (m[1] ?? '').trim();
      const text = (m[2] ?? m[1] ?? '').trim();
      const env = state.env as Env;
      const page = ctx.resolve(target);
      if (page) {
        env.page.links.add(page.source);
        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', page.url);
        open.attrSet('class', 'wikilink');
        state.push('text', '', 0).content = text;
        state.push('link_close', 'a', -1);
      } else {
        env.page.missing.push(target);
        const open = state.push('span_open', 'span', 1);
        open.attrSet('class', 'wikilink missing');
        state.push('text', '', 0).content = text;
        state.push('span_close', 'span', -1);
      }
    }
    state.pos += m[0].length;
    return true;
  });

  md.core.ruler.push('passa', (state: StateCore) => {
    const page = (state.env as Partial<Env>).page;
    if (!page) return;
    const tokens = state.tokens;
    if (page.startsWithHeading === undefined && !state.inlineMode) page.startsWithHeading = tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (!t) continue;
      // Heading anchors.
      if (t.type === 'heading_open') {
        const text = textOf(tokens[i + 1]?.children ?? null);
        let id = slugify(text) || 'section';
        while (page.ids.has(id)) id += '-1';
        page.ids.add(id);
        t.attrSet('id', id);
        if (t.tag === 'h1' && page.firstHeading === undefined) page.firstHeading = text;
        if (t.tag === 'h2' || t.tag === 'h3') page.toc.push({ id, text, level: Number(t.tag[1]) });
      }
      // Callouts: > [!note] Optional title
      const quoted = tokens[i + 2];
      if (t.type === 'blockquote_open' && quoted?.type === 'inline') {
        const m = /^\[!(\w+)\][ \t]*([^\n]*)\n?/.exec(quoted.content);
        if (m) {
          const kind = (m[1] ?? '').toLowerCase();
          t.attrSet('class', `callout callout-${kind}`);
          const title = m[2] || kind.charAt(0).toUpperCase() + kind.slice(1);
          // The title replaces the marker line; the rest of the paragraph stays.
          const children = quoted.children ?? [];
          const rest = children.findIndex((c) => c.type === 'softbreak');
          quoted.children = rest === -1 ? [] : children.slice(rest + 1);
          const titleToken = new state.Token('html_block', '', 0);
          titleToken.content = `<p class="callout-title">${escapeHtml(title)}</p>`;
          tokens.splice(i + 1, 0, titleToken);
        }
      }
      // The excerpt: the first top-level paragraph that reads as prose. Labels
      // ("Resources:"), lone links or images, and a few words don't count.
      const before = tokens[i - 1];
      if (page.excerpt === undefined && t.type === 'inline' && before?.type === 'paragraph_open' && before.level === 0) {
        let depth = 0;
        let outside = '';
        const text = (t.children ?? []).map((c) => {
          if (c.type === 'link_open') depth++;
          if (c.type === 'link_close') depth--;
          const s = c.type === 'text' || c.type === 'code_inline' ? c.content : c.type === 'softbreak' || c.type === 'hardbreak' ? ' ' : '';
          if (!depth) outside += s;
          return s;
        }).join('').replace(/\s+/g, ' ').trim();
        const prose = text.split(' ').length >= 6 && !/:$/.test(text) && !/^https?:\/\/\S+$/.test(text) && outside.replace(/[\s\p{P}]/gu, '').length >= 20;
        if (prose) page.excerpt = text;
      }
      if (t.type !== 'inline' || !t.children) continue;
      // Task lists: "[ ] " or "[x] " at the start of a list item.
      const item = tokens[i - 2];
      if (item?.type === 'list_item_open') {
        const first = t.children[0];
        const m = first?.type === 'text' ? /^\[([ xX])\] /.exec(first.content) : null;
        if (first && m) {
          first.content = first.content.slice(4);
          const box = new state.Token('html_inline', '', 0);
          box.content = `<input type="checkbox" disabled${m[1] === ' ' ? '' : ' checked'}> `;
          t.children.unshift(box);
          item.attrSet('class', 'task');
        }
      }
      // Relative links and images: made absolute from the source's folder, and
      // links to other sources (with or without .md) pointed at their pages.
      for (const c of t.children) {
        const attr = c.type === 'link_open' ? 'href' : c.type === 'image' ? 'src' : null;
        if (!attr) continue;
        const value = c.attrGet(attr);
        const href = value === null ? '' : String(value);
        if (!href || isAbsolute(href)) continue;
        const [pathPart = '', hash = ''] = href.split('#');
        const target = attr === 'href' && page.source ? ctx.resolve(pathPart, page.source) : undefined;
        if (target) {
          page.links.add(target.source);
          c.attrSet(attr, target.url + (hash ? `#${hash}` : ''));
        } else {
          c.attrSet(attr, resolveFrom(page.dir, pathPart) + (hash ? `#${hash}` : ''));
        }
      }
    }
  });
  return md;
}
