#!/usr/bin/env node
// The passa command: local commands that need no account or network (R92),
// and commands that work with a Passa deployment after passa login (R99–R112).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { contentSecurityPolicy, DEFAULT_CDN_ALLOWLIST } from '@passa/csp';
import { HTMX, THEME_GUIDE } from '@passa/render';
import { chooseServer, login, LoginNeeded, logout, readCredentials, serverUrl, useServer } from './auth.ts';
import { callTool, ToolRefused } from './mcp.ts';
import { addMember, type Ask, deleteSite, listAccess, listMembers, listShares, parseRules, publishFolder, removeMember, rollback, setAccess, setName, share, syncFolder, unshare, waitUntilServed } from './deploy.ts';
import { pull, resolveTarget, siteDetails, sitesList, writeLink } from './sites.ts';
import { BUILD_MARKER as MARKER, buildSite, drawSiteCard, isEmptyDir, type Build, type BuildOptions } from './site.ts';
import { initSite } from './init.ts';
import { adminTarget, AdminTargetRefused, lambdaLister } from './admin-link.ts';
import { AdminRefused, addDomain, awsRefusal, type DomainList, type DomainReport, formatList, formatStatus, formatUsers, lambdaInvoker, removeDomain, type UserReport } from './admin.ts';

const USAGE = `passa: build, preview, check and publish a site.

Local, with no account:
  passa render <folder> [--out dist]   build the site into a folder of HTML
  passa serve <folder> [--port 4321]   preview it on localhost, rebuilding on change
  passa check <folder>                 report the problems a publish would (exits 1 if any)
  passa init [folder]                  start a site
  passa theme guide                    print the theme contract, for writing themes
  passa --version                      print the version

With a Passa deployment:
  passa login [server]                 sign in through the browser (server: such as mcp.example.com)
  passa logout [server]                sign out, revoking the CLI's access
  passa whoami [--server <server>]     show which deployment you're signed in to
  passa use [server]                   switch to a deployment you've signed in to; lists them with no server
  passa sites [query]                  list your sites
  passa site <site|folder>             a site's details, access, versions and files
  passa pull <site> [folder]           write a site's sources and files to a folder, linked to the site
  passa publish <folder> --title <t>   publish a folder as a new private site, linked to the folder
  passa sync [folder] [--base]         make the folder's site exactly the folder (asks before removing files);
                                       draws the social cards for its public pages first (--no-cards to skip)
  passa access <site|folder>           show who can open what, and who it's shared with; change it with
                                       --public, --private, or --rule <path>=<access> (repeatable), where access
                                       is public, private, or tiers such as gold,silver; --as <email> shows
                                       what one person opens and why
  passa share <site|folder> <email>    share it with <email>, who gets an invite and can open it after signing
                                       in; --path /proposals/acme/ shares only that folder (default /);
                                       it ends after 90 days, or --expires 2026-12-31 or --for 30d (a year at
                                       most); --from 2026-12-01 starts it later; --yes skips asking
  passa unshare <site|folder> <email>  stop sharing with <email>, from their next request; --path for one folder
  passa shares [--site <site>] [--ending 30d]   every share across your sites, soonest end first
  passa members add <site|folder> <email> <tier>   add <email> to a tier (such as gold), who gets an
                                       invite; --from, --expires or --for as for share (no end: until removed)
  passa members remove <site|folder> <email> [--tier gold]   remove them from one tier, or every tier
  passa members list <site|folder> [--tier gold]   the site's members, their dates and last use
  passa name <site|folder> <name>      give a site a name (its address); --none removes it
  passa rollback <site|folder> [version]   restore a version (default: the one before the current one)
  passa delete <site|folder> [--now]   delete a site (after a grace period, or --now)

<site> is a site ID or name; a folder linked to a site (by publish or pull) works too.
Deployment commands take --server <server> and --json (the server's reply, for scripts).
The server is: --server if given, else a linked folder's, else $PASSA_SERVER, else the current one.
Anything that would make something public asks first (--confirm-public to skip in scripts);
removing files and deleting ask too (--yes).

Admin, with the deployment's AWS credentials (AWS_PROFILE, aws sso login), never through MCP:
  passa admin domain add <domain> <site> --fill-tenant|--new-tenant [--primary]
                                       attach a custom domain; --fill-tenant shares a tenant with room
                                       (CloudFront's first 10 are free), --new-tenant gives it its own
  passa admin domain list              every custom domain, its site, role and tenant
  passa admin domain status <domain>   a domain's DNS records and state
  passa admin domain remove <domain>   detach it; the site moves to its next address first
  passa admin users list               every user: admins, publishers, and viewers (people sites are shared with)
  passa admin users add <email> [--admin]   let an email publish (and run Passa, with --admin)
  passa admin users disable <email>    stop them, from their next call; admins in config, and the last
                                       active admin, can't be disabled
  passa admin users enable <email>     let them back in
  Admin commands work on the deployment you're signed in to (or --server). The first time, they ask
  which AWS profile reaches it (or take --profile), find its admin function, and remember both.
  --stage <stage> names the function directly; --region and --json too.

Options for render, serve and check:
  --site-url <url>      the site's address, for absolute links (default: url in _site.yml)
  --include-private     build every page, not only public ones (the output isn't protected)
  --confirm-public      build even if a page marked access: private would be public

Without _passa/access.yml (which Passa writes on publish), only pages whose front
matter says access: public are built.`;

// The CSP Passa serves sites with, and its default CDN allowlist.
const CSP = contentSecurityPolicy(DEFAULT_CDN_ALLOWLIST);
// Passa's copy of HTMX, for previews of pages that embed fragments (M7 R173).
const HTMX_FILE = createRequire(import.meta.url).resolve('htmx.org/dist/htmx.min.js');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};

// Set by scripts/build-cli.ts in the npm package; running from the repo, it's dev.
declare const PASSA_VERSION: string | undefined;
const VERSION = typeof PASSA_VERSION === 'string' ? PASSA_VERSION : 'dev';

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
  if (build.pages.some((p) => p.html.includes(HTMX))) {
    mkdirSync(join(dest, '_passa'), { recursive: true });
    cpSync(HTMX_FILE, join(dest, HTMX));
  }
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
    // Previews have no sign-in: the login block keeps its link (M7 R177, R178).
    if (path === '_passa/login') return res.writeHead(204, headers).end();
    if (path === '_passa/signin') return res.writeHead(200, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Previews have no sign-in. On Passa, this link signs in to the site and comes back to the page.');
    if (`/${path}` === HTMX) return res.writeHead(200, { ...headers, 'content-type': TYPES['.js'] }).end(readFileSync(HTMX_FILE));
    if (path === 'feed.xml' && build.feed) return res.writeHead(200, { ...headers, 'content-type': TYPES['.xml'] }).end(build.feed);
    if (files.has(path)) return res.writeHead(200, { ...headers, 'content-type': type }).end(readFileSync(join(folder, path)));
    const card = cards.get(path);
    if (card) {
      if (!drawn.has(card.hash)) drawn.set(card.hash, drawSiteCard(folder, build, card));
      return res.writeHead(200, { ...headers, 'content-type': 'image/png' }).end(await (drawn.get(card.hash) ?? Promise.reject(new Error('no card'))));
    }
    // As the edge answers a fragment its viewer can't open: nothing, so the fallback stays (M7 R174).
    if (req.headers['hx-request'] === 'true') return res.writeHead(204, headers).end();
    res.writeHead(404, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end('Not found (or not public).');
  }
  await new Promise<void>((done, fail) => server.once('error', fail).listen(port, '127.0.0.1', done));
  out(`\nServing ${shown(folder) || '.'} at ${local} (Ctrl+C to stop)`);
  return new Promise<number>(() => undefined);
}

async function loginCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const server = positionals[0] ? serverUrl(positionals[0]) : chooseServer(undefined, readCredentials());
  out(`Signing in to ${server}. Your browser will open; if it doesn't, open this link:`);
  await login(server, { show: (url) => out(`\n  ${url}\n`) });
  out(`Signed in to ${server}.`);
  return 0;
}

async function logoutCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const server = chooseServer(positionals[0], readCredentials());
  const { revoked } = await logout(server);
  out(revoked ? `Signed out of ${server}, and the CLI's access was revoked.` : `Signed out of ${server} on this computer.`);
  return 0;
}

async function whoamiCommand(args: string[]) {
  const { values } = parseArgs({ args, allowPositionals: false, options: { server: { type: 'string' } } });
  const server = chooseServer(values.server, readCredentials());
  const sites = await callTool<{ sites: unknown[]; next_cursor?: string }>(server, 'find_sites', { limit: 100 });
  const count = `${sites.sites.length}${sites.next_cursor ? '+' : ''}`;
  const from = !values.server && process.env.PASSA_SERVER ? ' (from PASSA_SERVER)' : '';
  out(`Signed in to ${server}${from}, with ${count} site${count === '1' ? '' : 's'}.`);
  return 0;
}

async function useCommand(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals[0]) {
    const server = serverUrl(positionals[0]);
    useServer(server);
    out(`Now using ${server}.`);
    if (process.env.PASSA_SERVER) out(`PASSA_SERVER is set (${serverUrl(process.env.PASSA_SERVER)}), and it takes precedence.`);
    return 0;
  }
  const credentials = readCredentials();
  const servers = Object.keys(credentials.servers);
  if (!servers.length) {
    out('Not signed in anywhere yet. Run: passa login <server>');
    return 0;
  }
  for (const server of servers) out(`${server === credentials.current ? '*' : ' '} ${server}`);
  if (process.env.PASSA_SERVER) out(`PASSA_SERVER is set, so commands use ${serverUrl(process.env.PASSA_SERVER)}.`);
  return 0;
}

const DEPLOY_OPTIONS = { server: { type: 'string' }, json: { type: 'boolean' } } as const;
const printJson = (value: unknown) => out(JSON.stringify(value, null, 2));

async function sitesCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: DEPLOY_OPTIONS });
  const server = chooseServer(values.server, readCredentials());
  const result = await sitesList(server, positionals[0]);
  if (values.json) return printJson(result), 0;
  if (!result.sites.length) return out(positionals[0] ? `No sites match ${positionals[0]}.` : 'No sites yet. Publish one with: passa publish <folder> --title <title>'), 0;
  for (const s of result.sites) out(`${(s.name ?? s.site_id).padEnd(22)} ${s.access.padEnd(8)} ${s.title}  ${s.url}${s.status === 'active' ? '' : `  (${s.status})`}`);
  if (result.next_cursor) out('…and more: narrow it with a query.');
  return 0;
}

async function siteCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: DEPLOY_OPTIONS });
  const target = await resolveTarget(positionals[0], values.server ? { server: values.server } : {});
  const site = await siteDetails(target);
  if (values.json) return printJson(site), 0;
  const sources = site.files.filter((f) => f.role === 'source').length;
  const rendered = site.files.filter((f) => f.role === 'rendered').length;
  out(`${site.title}  ${site.url}`);
  out(`  site ${site.site_id}${site.name ? `, named ${site.name}` : ''}; ${site.status}${site.delete_at ? `, deleted after ${site.delete_at}` : ''}`);
  out(`  access: ${site.access}${site.rules?.length ? ` (${site.rules.map((r) => `${r.path} ${shownAccess(r.access)}`).join(', ')})` : ''}`);
  out(`  files: ${site.files.length}${sources ? ` (${sources} sources, ${rendered} rendered by Passa)` : ''}`);
  out('  versions, newest first:');
  for (const v of site.versions) out(`    ${v.version_id}  ${v.created_at.slice(0, 16).replace('T', ' ')}  ${v.files} files${v.current ? '  (current)' : ''}`);
  return 0;
}

async function pullCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: DEPLOY_OPTIONS });
  if (!positionals[0]) throw new Error('Which site? passa pull <site> [folder]');
  const target = await resolveTarget(positionals[0], values.server ? { server: values.server } : {});
  const folder = resolve(positionals[1] ?? target.folder ?? target.siteId);
  const result = await pull(target, folder);
  if (values.json) return printJson({ site_id: target.siteId, folder, ...result }), 0;
  out(`Pulled ${result.files} file${result.files === 1 ? '' : 's'} of ${target.siteId} (version ${result.version}) into ${shown(folder) || '.'}.`);
  out('Pages Passa renders aren\'t included: they\'re rebuilt from the sources (passa serve to preview).');
  return 0;
}

// Asks on the terminal; without one, a question can't be answered, so the
// command stops (scripts pass --yes or --confirm-public).
// Asks the person to choose one of a few things, by number or name; nothing
// without a terminal (the AWS SDK's usual credentials are used then).
async function pickInTerminal(question: string, choices: string[]): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;
  out(question);
  choices.forEach((c, i) => out(`  ${i + 1}. ${c}`));
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('Number or name (Enter for the default credentials): ')).trim();
    return choices[Number(answer) - 1] ?? choices.find((c) => c === answer);
  } finally {
    rl.close();
  }
}

// skip: the options that answer yes in scripts.
const askTerminal = (yes: boolean, skip = '--yes (or --confirm-public)'): Ask => async (question) => {
  if (yes) return true;
  if (!process.stdin.isTTY) throw new Error(`${question}\nNo terminal to answer on: pass ${skip} to go ahead.`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
};

// A rule's access as people read it: public, private, or its tiers.
const shownAccess = (access: string[] | 'private') => (access === 'private' ? 'private' : access.join(', '));

// The server's notes worth showing after a change.
function notes(result: Record<string, unknown>) {
  const list = (key: string) => (Array.isArray(result[key]) ? (result[key] as string[]) : []);
  for (const p of list('problems')) out(`  warning: ${p}`);
  for (const p of list('skipped')) out(`  skipped: ${p}`);
  for (const p of list('cards_skipped')) out(`  card skipped: ${p}`);
  for (const p of list('card_problems')) out(`  warning: ${p}`);
  if (typeof result.cards_waiting === 'number') out(`  ${result.cards_waiting} social card${result.cards_waiting === 1 ? '' : 's'} still to draw: ${String(result.cards_note ?? '')}`);
  if (typeof result.note === 'string') out(`  ${result.note}`);
}

const targetOf = (arg: string | undefined, server: string | undefined) => resolveTarget(arg, server ? { server } : {});

async function publishCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEPLOY_OPTIONS, title: { type: 'string' }, 'confirm-public': { type: 'boolean' } } });
  if (!positionals[0] || !values.title) throw new Error('passa publish <folder> --title <title>');
  const server = chooseServer(values.server, readCredentials());
  // A site whose _site.yml declares access can be public from its first publish (M6), so this asks too.
  const r = await publishFolder(server, positionals[0], values.title, { ask: askTerminal(false), confirmPublic: values['confirm-public'] === true });
  if (values.json) return printJson(r), 0;
  out(`Published ${r.site_id}, ${String(r.access ?? 'private')}: ${r.url}`);
  notes(r);
  out(`The folder is linked to it: passa sync ${positionals[0]} updates it${r.access === 'private' ? `, passa access ${positionals[0]} --public makes it public` : ''}.`);
  return 0;
}

async function syncCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...DEPLOY_OPTIONS, base: { type: 'boolean' }, 'no-cards': { type: 'boolean' }, yes: { type: 'boolean' }, 'confirm-public': { type: 'boolean' },
  } });
  const target = await targetOf(positionals[0] ?? '.', values.server);
  const r = await syncFolder(target, {
    ask: askTerminal(values.yes === true), base: values.base === true, cards: values['no-cards'] !== true, confirmPublic: values['confirm-public'] === true,
  });
  if (values.json) return printJson(r), 0;
  if (r.up_to_date) return out(`${r.url} is up to date.`), 0;
  out(`Synced ${target.siteId} (version ${r.current_version}): ${String(r.changed ?? 0)} written, ${String(r.removed ?? 0)} removed.  ${r.url}`);
  if (r.cards_drawn_locally) out(`  drew ${r.cards_drawn_locally} social card${r.cards_drawn_locally === 1 ? '' : 's'} locally${typeof r.cards_stored === 'number' ? `; ${r.cards_stored} new to the site` : '; the site had them all'}`);
  notes(r);
  // Until the edge has the new version, a new page can 404 and others show the old one.
  const served = await waitUntilServed(r.url, r.current_version);
  if (served === 'live') out('  live: the edge is serving the new version');
  else if (served === 'slow') out('  Passa has it; the edge is still catching up, and will show it everywhere within a minute or so.');
  return 0;
}

async function accessCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...DEPLOY_OPTIONS, public: { type: 'boolean' }, private: { type: 'boolean' }, rule: { type: 'string', multiple: true }, 'confirm-public': { type: 'boolean' }, as: { type: 'string' },
  } });
  const target = await targetOf(positionals[0], values.server);
  const rules = parseRules(values);
  if (values.as && rules) throw new Error('--as only shows access; change it in a separate command.');
  if (values.as) {
    const site = await listAccess(target, { as: values.as });
    if (values.json) return printJson(site.as), 0;
    const as = site.as;
    if (!as) throw new Error('This deployment doesn\'t support --as yet.');
    out(`${as.email} on ${site.url}:`);
    for (const p of as.opens) out(`  opens   ${p.path}  (${p.why})`);
    for (const p of as.closed) out(`  closed  ${p.path}  (${p.why})`);
    return 0;
  }
  if (!rules) {
    const site = await listAccess(target);
    if (values.json) return printJson(site), 0;
    out(`${site.url} is ${site.access}.`);
    for (const r of site.rules) out(`  ${r.path} ${shownAccess(r.access)}`);
    if (!site.rules.length) out('  No rules: only you can open it.');
    if (site.tiers.length) out(`Tiers: ${site.tiers.join(', ')} (passa members list ${positionals[0] ?? ''} for who's in them)`);
    if (site.shares.length) out(`Shared with:`);
    for (const s of site.shares) out(`  ${s.email}  ${s.path}  since ${s.shared_at.slice(0, 10)}${shownDates(s)}${s.invited_at ? '' : ', not invited'}${s.opens_nothing ? ' (opens nothing)' : ''}`);
    if (site.note) out(`  ${site.note}`);
    return 0;
  }
  const r = await setAccess(target, rules, { ask: askTerminal(false), confirmPublic: values['confirm-public'] === true });
  if (values.json) return printJson(r), 0;
  out(`${String(r.url)} is now ${String(r.access)}.`);
  const made = (key: string) => (Array.isArray(r[key]) ? (r[key] as string[]) : []);
  if (made('made_public').length) out(`  made public: ${made('made_public').join(', ')}`);
  if (made('made_members').length) out(`  made for members: ${made('made_members').join(', ')}`);
  if (made('made_private').length) out(`  made private: ${made('made_private').join(', ')}`);
  notes(r);
  if (target.folder && target.link && typeof r.current_version === 'string') writeLinkVersion(target, r.current_version);
  return 0;
}

// A grant's dates as people read them (M6 R158, R166).
const when = (iso: string) => iso.slice(0, 16).replace('T', ' ');
function shownDates(g: { starts_at?: string; expires_at?: string; last_used?: string }) {
  return `${g.starts_at ? `, from ${when(g.starts_at)} UTC` : ''}${g.expires_at ? `, until ${when(g.expires_at)} UTC` : ''}${g.last_used ? `, last used ${g.last_used}` : ''}`;
}
const DATE_OPTIONS = { from: { type: 'string' }, expires: { type: 'string' }, for: { type: 'string' } } as const;
const datesOf = (values: { from?: string | undefined; expires?: string | undefined; for?: string | undefined }) => ({
  ...(values.from ? { from: values.from } : {}), ...(values.expires ? { expires: values.expires } : {}), ...(values.for ? { for: values.for } : {}),
});

async function shareCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    ...DEPLOY_OPTIONS, ...DATE_OPTIONS, path: { type: 'string' }, yes: { type: 'boolean' },
  } });
  const email = positionals[1];
  if (!email) throw new Error('passa share <site|folder> <email> [--path /plans/] [--from 2026-12-01] [--expires 2026-12-31 | --for 30d] [--yes]');
  const target = await targetOf(positionals[0], values.server);
  const r = await share(target, email, { ask: askTerminal(values.yes === true, '--yes'), ...(values.path ? { path: values.path } : {}), ...datesOf(values) });
  if (values.json) return printJson(r), 0;
  const shared = r.share as { email: string; path: string; starts_at?: string; expires_at?: string };
  out(`Shared ${shared.path} on ${target.siteId} with ${shared.email}${shownDates({ ...shared, last_used: '' })}.`);
  out(`  they can open ${String(r.url)}${shared.path.slice(1)}`);
  out(r.invite_sent ? '  invite sent' : `  ${String(r.invite_note ?? 'no invite sent')}`);
  if (typeof r.share_note === 'string') out(`  note: ${r.share_note}`);
  notes(r);
  if (target.folder && target.link && typeof r.current_version === 'string') writeLinkVersion(target, r.current_version);
  return 0;
}

async function unshareCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEPLOY_OPTIONS, path: { type: 'string' } } });
  const email = positionals[1];
  if (!email) throw new Error('passa unshare <site|folder> <email> [--path /plans/]');
  const target = await targetOf(positionals[0], values.server);
  const r = await unshare(target, email, values.path ? { path: values.path } : {});
  if (values.json) return printJson(r), 0;
  out(`${String(r.email)} can no longer open ${values.path ?? 'anything shared on'} ${values.path ? `on ${target.siteId}` : target.siteId}, from their next request.`);
  return 0;
}

// Every share across your sites, soonest end first (M6 R165).
async function sharesCommand(args: string[]) {
  const { values } = parseArgs({ args, options: { ...DEPLOY_OPTIONS, site: { type: 'string' }, ending: { type: 'string' } } });
  const server = chooseServer(values.server, readCredentials());
  const ending = values.ending ? /^(\d{1,3})d$/.exec(values.ending) : undefined;
  if (values.ending && !ending) throw new Error(`--ending takes a number of days, such as 30d, not ${values.ending}`);
  const siteId = values.site ? (await targetOf(values.site, values.server)).siteId : undefined;
  const shares = await listShares(server, { ...(siteId ? { siteId } : {}), ...(ending ? { endingWithinDays: Number(ending[1]) } : {}) });
  if (values.json) return printJson({ shares }), 0;
  if (!shares.length) return out(values.ending ? `No shares end within ${values.ending}.` : 'Nothing is shared.'), 0;
  for (const s of shares) out(`${when(s.expires_at ?? '').padEnd(16)}  ${s.email}  ${s.url}  shared ${s.shared_at.slice(0, 10)}${s.starts_at ? `, from ${when(s.starts_at)}` : ''}, last used ${s.last_used}`);
  out('Ends first (UTC). Remove one with: passa unshare <site> <email> --path <path>');
  return 0;
}

// Who is in a site's tiers (M6 R153–R155).
async function membersCommand(args: string[]) {
  const [sub, ...rest] = args;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    ...DEPLOY_OPTIONS, ...DATE_OPTIONS, tier: { type: 'string' }, yes: { type: 'boolean' },
  } });
  const usage = 'passa members add <site|folder> <email> <tier> [--from date] [--expires date | --for 30d] [--yes]\n'
    + '       passa members remove <site|folder> <email> [--tier gold]\n       passa members list <site|folder> [--tier gold]';
  if (sub === 'add') {
    const [site, email, tier] = positionals;
    if (!email || !tier) throw new Error(usage);
    const target = await targetOf(site, values.server);
    const r = await addMember(target, email, tier, { ask: askTerminal(values.yes === true, '--yes'), ...datesOf(values) });
    if (values.json) return printJson(r), 0;
    out(`Added ${r.member.email} to ${r.member.tier} on ${target.siteId}${shownDates({ ...r.member, last_used: '' })}.`);
    const urls = Array.isArray(r.tier_urls) ? (r.tier_urls as string[]) : [];
    if (urls.length) out(`  they can open ${urls.join(', ')}`);
    if (typeof r.tier_note === 'string') out(`  note: ${r.tier_note}`);
    out(r.invite_sent ? '  invite sent' : `  ${String(r.invite_note ?? 'no invite sent')}`);
    return 0;
  }
  if (sub === 'remove') {
    const [site, email] = positionals;
    if (!email) throw new Error(usage);
    const target = await targetOf(site, values.server);
    const r = await removeMember(target, email, values.tier ? { tier: values.tier } : {});
    if (values.json) return printJson(r), 0;
    out(`${r.email} is no longer a member of ${r.tier ?? 'any tier of'} ${r.tier ? `on ${target.siteId}` : target.siteId}, from their next request.`);
    return 0;
  }
  if (sub === 'list') {
    const target = await targetOf(positionals[0], values.server);
    const r = await listMembers(target, values.tier ? { tier: values.tier } : {});
    if (values.json) return printJson(r), 0;
    if (r.tiers.length) out(`Tiers its rules name: ${r.tiers.join(', ')}`);
    if (!r.members.length) return out(values.tier ? `Nobody is in ${values.tier}.` : 'No members yet. Add one with: passa members add <site> <email> <tier>'), 0;
    for (const m of r.members) out(`  ${m.email}  ${m.tier}  since ${m.added_at.slice(0, 10)}${shownDates(m)}${m.invited_at ? '' : ', not invited'}`);
    return 0;
  }
  throw new Error(usage);
}

// A change that made a new version (on a Markdown site) moves the folder's version along.
function writeLinkVersion(target: Awaited<ReturnType<typeof targetOf>>, version: string) {
  if (target.folder && target.link) writeLink(target.folder, { ...target.link, version });
}

async function nameCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEPLOY_OPTIONS, none: { type: 'boolean' } } });
  const name = values.none ? null : positionals[1];
  if (name === undefined) throw new Error('passa name <site|folder> <name>, or --none to remove it');
  const target = await targetOf(positionals[0], values.server);
  const r = await setName(target, name);
  if (values.json) return printJson(r), 0;
  out(name ? `${target.siteId} is now ${String(r.url)}` : `${target.siteId} has no name now: ${String(r.url)}`);
  const held = r.held as { name: string; until: string } | undefined;
  if (held) out(`  ${held.name} redirects here until ${held.until.slice(0, 10)}, and only you can claim it again.`);
  if (typeof r.current_version === 'string') writeLinkVersion(target, r.current_version);
  return 0;
}

async function rollbackCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEPLOY_OPTIONS, 'confirm-public': { type: 'boolean' } } });
  const target = await targetOf(positionals[0], values.server);
  const r = await rollback(target, positionals[1], { ask: askTerminal(false), confirmPublic: values['confirm-public'] === true });
  if (values.json) return printJson(r), 0;
  out(`Restored ${r.restored}${r.current_version === r.restored ? '' : ` as version ${r.current_version}`}: ${r.url}`);
  notes(r);
  return 0;
}

// passa admin domain|users …: invokes passa-<stage>-admin with AWS credentials (M4, M5).
async function adminCommand(args: string[]) {
  const [group, action, ...rest] = args;
  const usage = 'Usage: passa admin domain add|list|status|remove … or passa admin users add|list|disable|enable … (see passa --help)';
  const actions: Record<string, string[]> = { domain: ['add', 'list', 'status', 'remove'], users: ['add', 'list', 'disable', 'enable'] };
  if (!group || !action || !actions[group]?.includes(action)) throw new Error(usage);
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      stage: { type: 'string' }, profile: { type: 'string' }, region: { type: 'string' }, server: { type: 'string' }, json: { type: 'boolean' },
      'fill-tenant': { type: 'boolean' }, 'new-tenant': { type: 'boolean' }, primary: { type: 'boolean' }, admin: { type: 'boolean' },
    },
  });
  // The deployment: --stage, or the one signed in to (--server, $PASSA_SERVER, current).
  const credentials = readCredentials();
  const server = values.stage && !values.server ? undefined : (() => {
    try {
      return chooseServer(values.server, credentials);
    } catch {
      return undefined;
    }
  })();
  const target = await adminTarget({
    ...(server ? { server } : {}), ...(values.stage ? { stage: values.stage } : {}),
    ...(values.profile ? { profile: values.profile } : {}), ...(values.region ? { region: values.region } : {}),
    pick: pickInTerminal, lister: lambdaLister, refusal: (err, profile) => awsRefusal(err, 'the admin function', profile),
  });
  if (target.found && !values.json) out(`Using ${target.functionName}${target.profile ? ` through AWS profile ${target.profile}` : ''}; remembered for ${server ?? 'this deployment'}.`);
  const invoke = await lambdaInvoker(target.functionName, { ...(target.region ? { region: target.region } : {}), ...(target.profile ? { profile: target.profile } : {}) });
  const { userInfo, hostname } = await import('node:os');
  const actor = `${userInfo().username}@${hostname()}`;
  if (group === 'users') {
    if (action === 'list') {
      const users = await invoke({ action: 'users.list' }) as UserReport[];
      if (values.json) return printJson(users), 0;
      for (const line of formatUsers(users)) out(line);
      return 0;
    }
    const email = positionals[0];
    if (!email) throw new Error(`passa admin users ${action} needs an email.`);
    const user = await invoke({ action: `users.${action}`, email, actor, ...(action === 'add' && values.admin ? { admin: true } : {}) }) as UserReport;
    if (values.json) return printJson(user), 0;
    const said: Record<string, string> = {
      add: `${user.email} is ${user.roles.includes('admin') ? 'an admin' : 'a publisher'} now: they can sign in to MCP and the CLI with that email.`,
      disable: `${user.email} is disabled: refused from their next MCP call or sign-in.`,
      enable: `${user.email} is active again.`,
    };
    out(said[action] ?? '');
    return 0;
  }
  const progress = { out: values.json ? () => undefined : out };
  if (action === 'list') {
    const list = await invoke({ action: 'domain.list' }) as DomainList;
    if (values.json) return printJson(list), 0;
    for (const line of formatList(list)) out(line);
    return 0;
  }
  const domain = positionals[0];
  if (!domain) throw new Error(`passa admin domain ${action} needs a domain.`);
  if (action === 'status') {
    const report = await invoke({ action: 'domain.status', domain }) as DomainReport;
    if (values.json) return printJson(report), 0;
    for (const line of formatStatus(report)) out(line);
    return 0;
  }
  if (action === 'remove') {
    const report = await removeDomain(invoke, { domain, actor }, progress);
    if (values.json) printJson(report);
    return report.step === 'gone' ? 0 : 1;
  }
  const site = positionals[1];
  if (!site) throw new Error('passa admin domain add needs a domain and a site: passa admin domain add docs.example.com my-site --new-tenant');
  if (values['fill-tenant'] === values['new-tenant']) throw new Error('Choose one: --fill-tenant (share a tenant with room; the first 10 are free) or --new-tenant (its own tenant and certificate).');
  const report = await addDomain(invoke, { domain, site, tenant: values['new-tenant'] ? 'new' : 'fill', ...(values.primary ? { primary: true } : {}), actor }, progress);
  if (values.json) printJson(report);
  return report.step === 'live' ? 0 : 1;
}

async function deleteCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { ...DEPLOY_OPTIONS, now: { type: 'boolean' }, yes: { type: 'boolean' } } });
  const target = await targetOf(positionals[0], values.server);
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error('Deleting needs a terminal to confirm on, or --yes.');
    const { createInterface } = await import('node:readline/promises');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const typed = (await rl.question(`Type ${target.siteId} to delete it${values.now ? ' now and for good' : ''}: `)).trim();
    rl.close();
    if (typed !== target.siteId) throw new Error('That doesn\'t match, so nothing was deleted.');
  }
  const r = await deleteSite(target, values.now === true);
  if (values.json) return printJson(r), 0;
  out(r.deleted ? `Deleted ${target.siteId} for good.` : `${target.siteId} is no longer served, and is deleted for good after ${String(r.delete_at).slice(0, 10)}.`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'login': return loginCommand(rest);
    case 'logout': return logoutCommand(rest);
    case 'whoami': return whoamiCommand(rest);
    case 'use': return useCommand(rest);
    case 'admin': return adminCommand(rest);
    case 'sites': return sitesCommand(rest);
    case 'site': return siteCommand(rest);
    case 'pull': return pullCommand(rest);
    case 'publish': return publishCommand(rest);
    case 'sync': return syncCommand(rest);
    case 'access': return accessCommand(rest);
    case 'share': return shareCommand(rest);
    case 'unshare': return unshareCommand(rest);
    case 'shares': return sharesCommand(rest);
    case 'members': return membersCommand(rest);
    case 'name': return nameCommand(rest);
    case 'rollback': return rollbackCommand(rest);
    case 'delete': return deleteCommand(rest);
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
    case 'version': case '--version': case '-v':
      out(VERSION);
      return 0;
    case undefined: case 'help': case '--help': case '-h':
      out(USAGE);
      return 0;
  }
  err(`Unknown command: ${argv.join(' ')}\n\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e: unknown) => {
  // A refusal or a needed sign-in is meant for the person as it is.
  err(e instanceof ToolRefused || e instanceof LoginNeeded || e instanceof AdminRefused || e instanceof AdminTargetRefused ? e.message : `passa: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
