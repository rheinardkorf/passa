#!/usr/bin/env node
// The passa command. These commands work on a local folder, with no account
// and no network (R92); commands that talk to a deployment come later.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { contentSecurityPolicy, DEFAULT_CDN_ALLOWLIST } from '@passa/csp';
import { THEME_GUIDE } from '@passa/render';
import { buildSite, drawSiteCard, isEmptyDir, type Build, type BuildOptions } from './site.ts';
import { initSite } from './init.ts';

const USAGE = `passa: build, preview and check a Markdown site, with no account.

  passa render <folder> [--out dist]   build the site into a folder of HTML
  passa serve <folder> [--port 4321]   preview it on localhost, rebuilding on change
  passa check <folder>                 report the problems a publish would (exits 1 if any)
  passa init [folder]                  start a site
  passa theme guide                    print the theme contract, for writing themes

Options for render, serve and check:
  --site-url <url>      the site's address, for absolute links (default: url in _site.yml)
  --include-private     build every page, not only public ones (the output isn't protected)
  --confirm-public      build even if a page marked access: private would be public

Without _passa/access.yml (which Passa writes on publish), only pages whose front
matter says access: public are built.`;

// The CSP Passa serves sites with, and its default CDN allowlist.
const CSP = contentSecurityPolicy(DEFAULT_CDN_ALLOWLIST);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
const MARKER = '.passa-build';

const out = (line = '') => process.stdout.write(`${line}\n`);
// A path to show: relative when it's under the current folder, else absolute.
const shown = (path: string) => (path.startsWith(process.cwd() + sep) ? relative(process.cwd(), path) : path);
const err = (line: string) => process.stderr.write(`${line}\n`);

function report(build: Build, folder: string) {
  const access = build.access === 'rules' ? `access from ${relative(process.cwd(), join(folder, '_passa/access.yml')) || '_passa/access.yml'}`
    : build.access === 'front-matter' ? 'only pages marked access: public' : 'every page (--include-private: not safe to publish)';
  out(`${build.pages.length} pages, ${build.files.length} files (${access})`);
  if (build.skippedPages.length) out(`  left out ${build.skippedPages.length} page${build.skippedPages.length === 1 ? ' that isn\'t' : 's that aren\'t'} public${build.linksToSkipped ? `, and ${build.linksToSkipped} link${build.linksToSkipped === 1 ? '' : 's'} to them` : ''}`);
  if (build.skippedFiles.length) out(`  left out ${build.skippedFiles.length} file${build.skippedFiles.length === 1 ? '' : 's'} no built page uses`);
  for (const p of build.problems) (build.refusing.includes(p) ? err : out)(`  ${build.refusing.includes(p) ? 'error' : 'warning'} (${p.kind}): ${p.message}`);
  if (build.access === 'everything') err('  warning: this build includes private pages; don\'t publish the output anywhere public');
  if (build.access === 'front-matter' && build.skippedPages.length && !build.fromMarkdown) {
    out('  No page is marked public yet: add access: public to a page\'s front matter, or preview everything with --include-private.');
  }
}

function buildOptions(values: Record<string, unknown>, folder: string, ignore?: string): BuildOptions {
  return {
    ...(typeof values['site-url'] === 'string' ? { siteUrl: values['site-url'] } : {}),
    includePrivate: values['include-private'] === true,
    confirmPublic: values['confirm-public'] === true,
    ...(ignore ? { ignore } : {}),
  };
}

function siteFolder(arg: string | undefined): string {
  const folder = resolve(arg ?? '.');
  if (!existsSync(folder)) throw new Error(`no folder at ${folder}`);
  return folder;
}

async function renderCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    out: { type: 'string', default: 'dist' }, 'site-url': { type: 'string' }, 'include-private': { type: 'boolean' }, 'confirm-public': { type: 'boolean' },
  } });
  const folder = siteFolder(positionals[0]);
  const dest = resolve(values.out);
  if (dest === folder || folder.startsWith(dest + sep)) throw new Error('the output folder can\'t be the site folder or contain it');
  // Only replace a folder passa built (or an empty one), never anything else.
  if (!isEmptyDir(dest) && !existsSync(join(dest, MARKER))) throw new Error(`${dest} isn't empty and wasn't built by passa; choose another --out`);
  const build = buildSite(folder, buildOptions(values, folder, dest));
  report(build, folder);
  if (build.refusing.length) {
    err('Not built: fix the errors above (as a publish would refuse them).');
    return 1;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, MARKER), 'Built by passa render. passa replaces this folder on the next build.\n');
  for (const page of build.pages) {
    mkdirSync(dirname(join(dest, page.path)), { recursive: true });
    writeFileSync(join(dest, page.path), page.html);
  }
  if (build.feed) writeFileSync(join(dest, 'feed.xml'), build.feed);
  for (const file of build.files) {
    mkdirSync(dirname(join(dest, file)), { recursive: true });
    cpSync(join(folder, file), join(dest, file));
  }
  const drawn = new Map<string, Uint8Array>();
  for (const card of build.cards) {
    const png = drawn.get(card.hash) ?? await drawSiteCard(folder, build, card);
    drawn.set(card.hash, png);
    mkdirSync(dirname(join(dest, card.path)), { recursive: true });
    writeFileSync(join(dest, card.path), png);
  }
  out(`Built into ${shown(dest)}${build.cards.length ? `, with ${drawn.size} social card${drawn.size === 1 ? '' : 's'}` : ''}`);
  return 0;
}

function checkCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'site-url': { type: 'string' }, 'include-private': { type: 'boolean' }, 'confirm-public': { type: 'boolean' },
  } });
  const folder = siteFolder(positionals[0]);
  const build = buildSite(folder, buildOptions(values, folder));
  report(build, folder);
  out(build.problems.length ? `${build.problems.length} problem${build.problems.length === 1 ? '' : 's'}` : 'No problems');
  return build.problems.length ? 1 : 0;
}

async function serveCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    port: { type: 'string', default: '4321' }, 'site-url': { type: 'string' }, 'include-private': { type: 'boolean' }, 'confirm-public': { type: 'boolean' },
  } });
  const folder = siteFolder(positionals[0]);
  const port = Number(values.port);
  const local = `http://127.0.0.1:${port}/`;
  const options = { ...buildOptions(values, folder), siteUrl: typeof values['site-url'] === 'string' ? values['site-url'] : local };
  let build = buildSite(folder, options);
  report(build, folder);
  let pages = new Map(build.pages.map((p) => [p.path, p.html]));
  let files = new Set(build.files);
  // Cards are drawn when asked for, once per hash.
  let cards = new Map(build.cards.map((c) => [c.path, c]));
  const drawn = new Map<string, Promise<Uint8Array>>();

  // Rebuild when anything in the folder changes, a moment after the last change.
  let timer: NodeJS.Timeout | undefined;
  watch(folder, { recursive: true }, (_event, name) => {
    if (name && name.split(sep).some((part) => part.startsWith('.') || part === 'node_modules')) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        build = buildSite(folder, options);
        pages = new Map(build.pages.map((p) => [p.path, p.html]));
        files = new Set(build.files);
        cards = new Map(build.cards.map((c) => [c.path, c]));
        out(`\nRebuilt at ${new Date().toLocaleTimeString()}:`);
        report(build, folder);
      } catch (e) {
        err(`Rebuild failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, 150);
  });

  const server = createServer((req, res) => void respond(req, res).catch((e: unknown) => {
    err(`Couldn't serve ${req.url ?? ''}: ${e instanceof Error ? e.message : String(e)}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('Couldn\'t draw this card; see the terminal.');
  }));
  async function respond(req: IncomingMessage, res: ServerResponse) {
    let path = decodeURIComponent(new URL(req.url ?? '/', local).pathname).replace(/^\//, '');
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const headers = { 'content-security-policy': CSP, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const type = TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
    if (pages.has(path)) return res.writeHead(200, { ...headers, 'content-type': TYPES['.html'] }).end(pages.get(path));
    if (pages.has(`${path}/index.html`)) return res.writeHead(301, { location: `/${path}/` }).end();
    if (path === 'feed.xml' && build.feed) return res.writeHead(200, { ...headers, 'content-type': TYPES['.xml'] }).end(build.feed);
    if (files.has(path)) return res.writeHead(200, { ...headers, 'content-type': type }).end(readFileSync(join(folder, path)));
    const card = cards.get(path);
    if (card) {
      if (!drawn.has(card.hash)) drawn.set(card.hash, drawSiteCard(folder, build, card));
      return res.writeHead(200, { ...headers, 'content-type': 'image/png' }).end(await (drawn.get(card.hash) ?? Promise.reject(new Error('no card'))));
    }
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Not found (or not public).');
  }
  await new Promise<void>((done, fail) => server.once('error', fail).listen(port, '127.0.0.1', done));
  out(`\nServing ${shown(folder) || '.'} at ${local} (Ctrl+C to stop)`);
  return new Promise<number>(() => undefined);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'render': return renderCommand(rest);
    case 'check': return checkCommand(rest);
    case 'serve': return serveCommand(rest);
    case 'init': {
      const created = initSite(resolve(rest[0] ?? '.'));
      out(`Started a site in ${shown(resolve(rest[0] ?? '.')) || '.'}: ${created.join(', ')}`);
      out(`Preview it with: passa serve ${rest[0] ?? '.'}`);
      return 0;
    }
    case 'theme':
      if (rest[0] === 'guide') {
        out(THEME_GUIDE);
        return 0;
      }
      break;
    case undefined: case 'help': case '--help': case '-h':
      out(USAGE);
      return 0;
  }
  err(`Unknown command: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
  err(`passa: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
