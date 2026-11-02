// Changing sites from the CLI (R106–R110): publish and sync a folder (with the
// cards passa render draws), access, names, rollback and delete. The server
// decides what's allowed; the CLI asks before anything it confirms.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { request } from './http.ts';
import { callTool, type CallOptions, ToolRefused } from './mcp.ts';
import { buildSite, drawSiteCard, walk } from './site.ts';
import { readLink, siteDetails, type Target, writeLink } from './sites.ts';

// Asks the person a question; true to go ahead. Commands pass one that reads
// the terminal, tests one that answers.
export type Ask = (question: string) => Promise<boolean>;

export type Rule = { path: string; tier: string };
type FileToSend = { path: string; content: Uint8Array };

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
// A refusal that confirm_public would get past.
const needsConfirm = (err: unknown) => err instanceof ToolRefused && err.message.includes('confirm_public');

// The folder's files, and its cards when the site's rules make pages public
// (R108): drawn as Passa would, with the site's rules, address and title.
async function folderToSend(folder: string, cards: { rules: Rule[]; siteUrl: string; siteTitle: string } | undefined): Promise<{ files: FileToSend[]; cards: number }> {
  const files: FileToSend[] = walk(folder).filter((p) => !p.startsWith('_passa/')).map((path) => ({ path, content: readFileSync(join(folder, path)) }));
  if (!cards || !cards.rules.some((r) => r.tier === 'public')) return { files, cards: 0 };
  const build = buildSite(folder, { rules: cards.rules, siteUrl: cards.siteUrl, siteTitle: cards.siteTitle });
  const drawn = new Map<string, Uint8Array>();
  for (const card of build.cards) {
    const png = drawn.get(card.hash) ?? await drawSiteCard(folder, build, card);
    drawn.set(card.hash, png);
    files.push({ path: card.path, content: png });
  }
  return { files, cards: drawn.size };
}

type Upload = { upload_id?: string; up_to_date?: boolean; uploads?: { path: string; url: string; headers: Record<string, string> }[]; sync?: { remove: string[]; unchanged: number }; skipped?: string[] };

// begin_upload, the PUTs, finish_upload: the upload's ID, or nothing to send.
async function upload(server: string, files: FileToSend[], siteId: string | undefined, options: CallOptions, beforePut?: (begun: Upload) => Promise<void>): Promise<Upload> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const begun = await callTool<Upload>(server, 'begin_upload', {
    files: files.map((f) => ({ path: f.path, size: f.content.byteLength, sha256: sha256(f.content) })),
    ...(siteId ? { site_id: siteId } : {}),
  }, options);
  if (begun.up_to_date) return begun;
  await beforePut?.(begun);
  for (const u of begun.uploads ?? []) {
    const reply = await request(u.url, { method: 'PUT', headers: u.headers, body: byPath.get(u.path)?.content ?? new Uint8Array() });
    if (reply.status >= 300) throw new Error(`Uploading ${u.path} failed (HTTP ${reply.status}).`);
  }
  await callTool(server, 'finish_upload', { upload_id: begun.upload_id }, options);
  return begun;
}

export type Published = Record<string, unknown> & { site_id: string; url: string; current_version: string };

// R106: a new private site from a folder, which is then linked to it.
export async function publishFolder(server: string, folder: string, title: string, options: CallOptions & { ask: Ask; confirmPublic?: boolean }): Promise<Published> {
  const dir = resolve(folder);
  if (readLink(dir)) throw new Error(`${dir} is already linked to a site; use passa sync to update it.`);
  const { files } = await folderToSend(dir, undefined); // new sites are private, so no cards
  const go = async (confirmPublic: boolean) => {
    const begun = await upload(server, files, undefined, options);
    return callTool<Published>(server, 'publish', { title, upload_id: begun.upload_id, ...(confirmPublic ? { confirm_public: true } : {}) }, options);
  };
  const result = await withConfirm(go, options);
  writeLink(dir, { server, site: result.site_id, version: result.current_version });
  return result;
}

export type Synced = Published & { up_to_date?: boolean; cards_drawn_locally?: number; removed?: number };

// R107, R108: makes the linked site exactly the folder.
export async function syncFolder(target: Target, options: CallOptions & { ask: Ask; base?: boolean; cards?: boolean; confirmPublic?: boolean }): Promise<Synced> {
  const folder = target.folder;
  if (!folder || !target.link) throw new Error('passa sync works on a folder linked to a site (by passa publish or passa pull).');
  const site = await siteDetails(target, options);
  if (options.base && target.link.version && site.current_version !== target.link.version) {
    throw new Error(`The site has changed since this folder was last synced or pulled (it's at ${site.current_version}, the folder at ${target.link.version}). Pull it first, or sync without --base.`);
  }
  const { files, cards } = await folderToSend(folder, options.cards === false ? undefined : { rules: site.rules ?? [], siteUrl: site.url, siteTitle: site.title });
  const go = async (confirmPublic: boolean): Promise<Synced> => {
    const begun = await upload(target.server, files, target.siteId, options, async (b) => {
      const remove = b.sync?.remove ?? [];
      if (remove.length && !(await options.ask(`This removes ${remove.length} file${remove.length === 1 ? '' : 's'} the folder doesn't have:\n${remove.map((p) => `  ${p}`).join('\n')}\nGo ahead?`))) {
        throw new Error('Nothing was changed.');
      }
    });
    if (begun.up_to_date) return { site_id: target.siteId, url: site.url, current_version: site.current_version, up_to_date: true };
    return callTool<Synced>(target.server, 'update', {
      site_id: target.siteId, upload_id: begun.upload_id, sync: true,
      ...(options.base && target.link?.version ? { base_version: target.link.version } : {}),
      ...(confirmPublic ? { confirm_public: true } : {}),
    }, options);
  };
  const result = await withConfirm(go, options);
  writeLink(folder, { server: target.server, site: target.siteId, version: result.current_version });
  return { ...result, ...(cards ? { cards_drawn_locally: cards } : {}) };
}

// Runs a change; if the server needs confirm_public, shows why, asks, and runs it again.
async function withConfirm<T>(go: (confirmPublic: boolean) => Promise<T>, options: { ask: Ask; confirmPublic?: boolean }): Promise<T> {
  if (options.confirmPublic) return go(true);
  try {
    return await go(false);
  } catch (err) {
    if (!needsConfirm(err)) throw err;
    if (!(await options.ask(`${(err as Error).message}\nMake it public?`))) throw new Error('Nothing was changed.', { cause: err });
    return go(true);
  }
}

// R109: replaces a site's rules, asking before anything goes public.
export function setAccess(target: Target, rules: Rule[], options: CallOptions & { ask: Ask; confirmPublic?: boolean }) {
  return withConfirm((confirmPublic) => callTool<Record<string, unknown>>(target.server, 'set_access', { site_id: target.siteId, rules, confirm_public: confirmPublic }, options), options);
}

export const setName = (target: Target, name: string | null, options: CallOptions = {}) =>
  callTool<Record<string, unknown>>(target.server, 'set_name', { site_id: target.siteId, name }, options);

// R110: the given version, or the one before the current one.
export async function rollback(target: Target, version: string | undefined, options: CallOptions & { ask: Ask; confirmPublic?: boolean }) {
  let to = version;
  if (!to) {
    const site = await siteDetails(target, options);
    const at = site.versions.findIndex((v) => v.current);
    to = site.versions[at + 1]?.version_id;
    if (!to) throw new Error('There\'s no earlier version to roll back to.');
  }
  const result = await withConfirm((confirmPublic) => callTool<Published>(target.server, 'rollback', { site_id: target.siteId, version_id: to, confirm_public: confirmPublic }, options), options);
  if (target.folder && target.link) writeLink(target.folder, { ...target.link, version: result.current_version });
  return { ...result, restored: to };
}

export const deleteSite = (target: Target, now: boolean, options: CallOptions = {}) =>
  callTool<Record<string, unknown>>(target.server, 'delete', { site_id: target.siteId, now }, options);

// --rule /docs/=public, --public, --private: the rules they mean.
export function parseRules(values: { public?: boolean; private?: boolean; rule?: string[] }): Rule[] | undefined {
  if (values.public) return [{ path: '/', tier: 'public' }];
  if (values.private) return [];
  if (!values.rule?.length) return undefined;
  return values.rule.map((r) => {
    const at = r.lastIndexOf('=');
    if (at < 1) throw new Error(`--rule takes <path>=<tier>, such as /docs/=public, not ${r}`);
    return { path: r.slice(0, at), tier: r.slice(at + 1) };
  });
}
