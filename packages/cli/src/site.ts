// Builds a Markdown folder outside Passa (R92, R93): the same renderer as a
// publish, but nothing enforces access afterwards, so only what's public is
// built, and only files the built pages use are kept.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isSource, REFUSING, render, RULES_FILE, slugify, type Problem, type Rule, type Source } from '@passa/render';

export type BuildOptions = {
  siteUrl?: string;
  // Build every page, public or not (local preview only: the output isn't protected).
  includePrivate?: boolean;
  // Build anyway when a page marked `access: private` would be public (R89).
  confirmPublic?: boolean;
  // A folder inside the site to leave out (the output, when it's there).
  ignore?: string;
};

export type Build = {
  // How access was decided: the site's rules file, pages' front matter, or not at all.
  access: 'rules' | 'front-matter' | 'everything';
  siteUrl: string;
  pages: { path: string; html: string }[];
  // How many of the pages came from Markdown files (the rest are generated).
  fromMarkdown: number;
  feed?: string;
  // Plain files the built pages use, relative to the site folder.
  files: string[];
  problems: Problem[];
  // Problems that stop a build, as they'd stop a publish.
  refusing: Problem[];
  // Pages and files left out because they aren't public or aren't used.
  skippedPages: string[];
  skippedFiles: string[];
  // Links to pages that exist but weren't built because they aren't public.
  linksToSkipped: number;
};

const SKIP = new Set(['node_modules']);

const toPosix = (p: string) => p.split(sep).join('/');

function walk(root: string, ignore?: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (ignore && (full === ignore || full.startsWith(ignore + sep))) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(toPosix(relative(root, full)));
    }
  };
  visit(root);
  return out.sort();
}

function frontMatter(content: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  try {
    const data: unknown = parseYaml(m[1] ?? '');
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// The rules file Passa writes on every publish: a list of { path, tier }.
export function readRules(content: string): Rule[] {
  const parsed: unknown = parseYaml(content);
  if (!Array.isArray(parsed) || !parsed.every((r) => r && typeof r === 'object' && typeof r.path === 'string' && typeof r.tier === 'string')) {
    throw new Error(`${RULES_FILE} must be a list of { path, tier }`);
  }
  return parsed.map((r: Rule) => ({ path: r.path, tier: r.tier }));
}

// Site paths a page or stylesheet refers to: href, src, srcset, poster and
// Open Graph content; url() and @import in CSS.
function references(text: string, isCss: boolean): string[] {
  const found: string[] = [];
  if (isCss) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)|@import\s+['"]([^'"]+)['"]/g)) found.push(m[1] ?? m[2] ?? '');
  } else {
    for (const m of text.matchAll(/\s(?:href|src|poster|content)="([^"]+)"/g)) found.push(m[1] ?? '');
    for (const m of text.matchAll(/\ssrcset="([^"]+)"/g)) for (const part of (m[1] ?? '').split(',')) found.push(part.trim().split(/\s+/)[0] ?? '');
  }
  return found;
}

export function buildSite(root: string, options: BuildOptions = {}): Build {
  const all = walk(root, options.ignore);
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const siteYml = all.includes('_site.yml') ? (frontMatter(`---\n${read('_site.yml')}\n---`)) : {};
  const siteUrl = options.siteUrl ?? (typeof siteYml.url === 'string' ? siteYml.url : 'http://localhost:4321/');
  const plain = all.filter((p) => !isSource(p) && !p.startsWith('_passa/'));
  let sources: Source[] = all.filter(isSource).map((path) => ({ path, content: read(path) }));
  const markdown = (s: Source) => s.path.endsWith('.md');

  // How access is decided (R93): the rules file wins; without one, only pages
  // marked access: public are built; --include-private builds everything.
  const hasRules = existsSync(join(root, RULES_FILE));
  const access: Build['access'] = options.includePrivate ? 'everything' : hasRules ? 'rules' : 'front-matter';
  let rules: Rule[] = [{ path: '/', tier: 'public' }];
  let skippedPages: string[] = [];
  if (access === 'rules') rules = readRules(read(RULES_FILE));
  if (access === 'front-matter') {
    skippedPages = sources.filter((s) => markdown(s) && String(frontMatter(s.content).access ?? '').toLowerCase() !== 'public').map((s) => s.path);
    sources = sources.filter((s) => !skippedPages.includes(s.path));
  }

  const result = render({ sources, rules, siteUrl, siteTitle: typeof siteYml.title === 'string' ? siteYml.title : 'Site', files: plain });
  let pages = result.pages;
  let feed = result.feed;
  if (access === 'rules') {
    const hidden = pages.filter((p) => p.tier !== 'public');
    skippedPages = hidden.flatMap((p) => (p.from ? [p.from] : []));
    pages = pages.filter((p) => p.tier === 'public');
  }

  // A link to a page that exists but isn't public renders as missing, like any
  // missing page; it isn't a problem with the site, so it's counted, not reported.
  const key = (s: string) => slugify(s.replace(/\.md$/i, ''));
  const skippedKeys = new Set(skippedPages.flatMap((path) => {
    const title = frontMatter(read(path)).title;
    return [key(path), key(path.slice(path.lastIndexOf('/') + 1)), ...(typeof title === 'string' ? [key(title)] : [])];
  }));
  let linksToSkipped = 0;
  const problems = result.problems.filter((p) => {
    const target = p.kind === 'missing-link' ? /^\[\[(.+)\]\] doesn't match/.exec(p.message)?.[1] : undefined;
    if (target && skippedKeys.has(key(target))) {
      linksToSkipped++;
      return false;
    }
    // Problems on pages that weren't built don't matter here.
    return !(p.source && skippedPages.includes(p.source));
  });
  const refusing = problems.filter((p) => REFUSING.has(p.kind) && !(p.kind === 'access-private-made-public' && options.confirmPublic));

  // Keep only the plain files built pages use, following stylesheets and HTML
  // files to what they use in turn.
  const origin = new URL(siteUrl);
  const plainSet = new Set(plain);
  const files = new Set<string>();
  const queue = pages.map((p) => ({ from: p.path, text: p.html, css: false }));
  while (queue.length) {
    const { from, text, css } = queue.shift() ?? { from: '', text: '', css: false };
    for (const ref of references(text, css)) {
      let url: URL;
      try {
        url = new URL(ref, new URL(from, origin));
      } catch {
        continue;
      }
      if (url.origin !== origin.origin) continue;
      const path = decodeURIComponent(url.pathname).replace(/^\//, '');
      const target = plainSet.has(path) ? path : plainSet.has(posix.join(path, 'index.html')) ? posix.join(path, 'index.html') : undefined;
      if (!target || files.has(target)) continue;
      files.add(target);
      if (target.endsWith('.css') || target.endsWith('.html')) queue.push({ from: target, text: read(target), css: target.endsWith('.css') });
    }
  }
  if (feed && access === 'everything') feed = undefined; // a feed is for publishing, and this build isn't safe to publish

  return {
    access, siteUrl, pages: pages.map(({ path, html }) => ({ path, html })), fromMarkdown: pages.filter((p) => p.from).length, ...(feed ? { feed } : {}),
    files: [...files].sort(), problems, refusing,
    skippedPages: skippedPages.sort(), skippedFiles: plain.filter((p) => !files.has(p)), linksToSkipped,
  };
}

// True if the path is a directory with nothing in it (or doesn't exist).
export const isEmptyDir = (path: string) => !existsSync(path) || (statSync(path).isDirectory() && readdirSync(path).length === 0);
