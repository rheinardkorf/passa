// Changing sites from the CLI (R106–R110): publish and sync a folder (with the
// cards passa render draws), access, sharing (M5 R139), names, rollback and
// delete. The server decides what's allowed; the CLI asks before anything it confirms.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Rule } from '@passa/render';
import { request } from './http.ts';
import { callTool, type CallOptions, ToolRefused } from './mcp.ts';
import { buildSite, drawSiteCard, walk } from './site.ts';
import { readLink, siteDetails, type Target, writeLink } from './sites.ts';

// Asks the person a question; true to go ahead. Commands pass one that reads
// the terminal, tests one that answers.
export type Ask = (question: string) => Promise<boolean>;

export type { Rule } from '@passa/render';
type FileToSend = { path: string; content: Uint8Array };

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
// A refusal that confirm_public would get past.
const needsConfirm = (err: unknown) => err instanceof ToolRefused && err.message.includes('confirm_public');

// The folder's files, and its cards when the site's rules make pages public
// (R108): drawn as Passa would, with the site's rules, address and title.
async function folderToSend(folder: string, cards: { rules: Rule[]; siteUrl: string; siteTitle: string } | undefined): Promise<{ files: FileToSend[]; cards: number }> {
  const files: FileToSend[] = walk(folder).filter((p) => !p.startsWith('_passa/')).map((path) => ({ path, content: readFileSync(join(folder, path)) }));
  if (!cards || !cards.rules.some((r) => r.access !== 'private' && r.access.includes('public'))) return { files, cards: 0 };
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

const SCAN_WAIT_MS = 3000;
const SCAN_TRIES = 40; // about two minutes

// Uploads are scanned for malware before they can be used, which takes a few
// seconds. The server checks before it claims the upload, so the same call
// can simply be made again.
async function afterScans<T>(call: () => Promise<T>, options: { waitMs?: number } = {}): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof ToolRefused) || !err.message.includes('still being scanned') || i >= SCAN_TRIES) throw err;
      await new Promise((r) => setTimeout(r, options.waitMs ?? SCAN_WAIT_MS));
    }
  }
}

// R106: a new private site from a folder, which is then linked to it.
export async function publishFolder(server: string, folder: string, title: string, options: CallOptions & { ask: Ask; confirmPublic?: boolean }): Promise<Published> {
  const dir = resolve(folder);
  if (readLink(dir)) throw new Error(`${dir} is already linked to a site; use passa sync to update it.`);
  const { files } = await folderToSend(dir, undefined); // new sites are private, so no cards
  const go = async (confirmPublic: boolean) => {
    const begun = await upload(server, files, undefined, options);
    return afterScans(() => callTool<Published>(server, 'publish', { title, upload_id: begun.upload_id, ...(confirmPublic ? { confirm_public: true } : {}) }, options));
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
    return afterScans(() => callTool<Synced>(target.server, 'update', {
      site_id: target.siteId, upload_id: begun.upload_id, sync: true,
      ...(options.base && target.link?.version ? { base_version: target.link.version } : {}),
      ...(confirmPublic ? { confirm_public: true } : {}),
    }, options));
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

// The edge takes a few seconds (sometimes a minute) to see a new version
// everywhere. Public responses say which version they serve, so this checks
// the site's home page until it's the new one. A private home page doesn't
// say, so there's nothing to wait for: 'unknown'.
export async function waitUntilServed(url: string, version: string, options: { tries?: number; waitMs?: number } = {}): Promise<'live' | 'unknown' | 'slow'> {
  for (let i = 0; i < (options.tries ?? 20); i++) {
    const reply = await request(url).catch(() => undefined);
    const served = reply?.headers['x-passa-version'];
    if (served === version) return 'live';
    if (reply && !served && reply.status !== 404) return 'unknown';
    await new Promise((r) => setTimeout(r, options.waitMs ?? 3000));
  }
  return 'slow';
}

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

// When a grant begins and ends (M6 R158), from --from, --expires and --for. A
// date alone begins at the start of that day and ends at its end (UTC); --for
// (30d, 12w, 6m, 1y) counts from the start, or from now.
export type GrantDates = { from?: string; expires?: string; for?: string };
export function grantDates(dates: GrantDates, now = new Date()): { starts_at?: string; expires_at?: string } {
  if (dates.expires && dates.for) throw new Error('Choose one: --expires <date> or --for <duration>.');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const startsAt = dates.from && day.test(dates.from) ? `${dates.from}T00:00:00Z` : dates.from;
  let expiresAt = dates.expires && day.test(dates.expires) ? `${dates.expires}T23:59:59Z` : dates.expires;
  if (dates.for) {
    const m = /^(\d{1,4})([dwmy])$/.exec(dates.for);
    if (!m) throw new Error(`--for takes a number and d, w, m or y, such as 30d or 1y, not ${dates.for}`);
    const n = Number(m[1]);
    const end = new Date(startsAt ? Date.parse(startsAt) : now.getTime());
    if (Number.isNaN(end.getTime())) throw new Error(`--from takes a date such as 2026-12-01, not ${dates.from}`);
    if (m[2] === 'd' || m[2] === 'w') end.setUTCDate(end.getUTCDate() + n * (m[2] === 'w' ? 7 : 1));
    else end.setUTCMonth(end.getUTCMonth() + n * (m[2] === 'y' ? 12 : 1));
    expiresAt = end.toISOString();
  }
  return { ...(startsAt ? { starts_at: startsAt } : {}), ...(expiresAt ? { expires_at: expiresAt } : {}) };
}

// M5 R129: the person checks the email before anything is shared, as an agent
// reads it back.
export async function share(target: Target, email: string, options: CallOptions & GrantDates & { ask: Ask; path?: string }) {
  const address = email.trim().toLowerCase();
  const dates = grantDates(options);
  const what = options.path && options.path !== '/' ? `${options.path} on ${target.siteId}` : target.siteId;
  const question = `Share ${what} with ${address}? They'll get an email inviting them to sign in with that address and open it.`;
  if (!(await options.ask(question))) throw new Error('Nothing was shared.');
  return callTool<Record<string, unknown>>(target.server, 'share', {
    site_id: target.siteId, email: address, confirm_share: true, ...(options.path ? { path: options.path } : {}), ...dates,
  }, options);
}

export const unshare = (target: Target, email: string, options: CallOptions & { path?: string } = {}) =>
  callTool<Record<string, unknown>>(target.server, 'unshare', { site_id: target.siteId, email: email.trim().toLowerCase(), ...(options.path ? { path: options.path } : {}) }, options);

type Dates = { starts_at?: string; expires_at?: string; invited_at?: string; last_used: string };
export type Share = { email: string; path: string; shared_at: string; opens_nothing?: boolean } & Dates;
export type PathAccess = { path: string; url: string; why: string };
export const listAccess = (target: Target, options: CallOptions & { as?: string } = {}) =>
  callTool<{ url: string; access: string; rules: Rule[]; tiers: string[]; shares: Share[]; note?: string; as?: { email: string; opens: PathAccess[]; closed: PathAccess[] } }>(
    target.server, 'list_access', { site_id: target.siteId, ...(options.as ? { email: options.as.trim().toLowerCase() } : {}) }, options);

// M6 R153: as sharing, the person checks the email first.
export async function addMember(target: Target, email: string, tier: string, options: CallOptions & GrantDates & { ask: Ask }) {
  const address = email.trim().toLowerCase();
  const dates = grantDates(options);
  const question = `Add ${address} to ${tier} on ${target.siteId}? They'll get an email inviting them to sign in with that address.`;
  if (!(await options.ask(question))) throw new Error('Nobody was added.');
  return callTool<Record<string, unknown> & { member: Member }>(target.server, 'add_member', { site_id: target.siteId, email: address, tier, confirm_member: true, ...dates }, options);
}

export const removeMember = (target: Target, email: string, options: CallOptions & { tier?: string } = {}) =>
  callTool<{ email: string; tier?: string; removed: number }>(target.server, 'remove_member', { site_id: target.siteId, email: email.trim().toLowerCase(), ...(options.tier ? { tier: options.tier } : {}) }, options);

export type Member = { email: string; tier: string; added_at: string } & Dates;
// Every page of a site's members (or one tier's).
export async function listMembers(target: Target, options: CallOptions & { tier?: string } = {}) {
  const members: Member[] = [];
  let cursor: string | undefined;
  let tiers: string[];
  do {
    const page = await callTool<{ tiers: string[]; members: Member[]; next_cursor?: string }>(target.server, 'list_members', {
      site_id: target.siteId, ...(options.tier ? { tier: options.tier } : {}), ...(cursor ? { cursor } : {}),
    }, options);
    members.push(...page.members);
    tiers = page.tiers;
    cursor = page.next_cursor;
  } while (cursor);
  return { tiers, members };
}

export type OwnerShare = Share & { site_id: string; url: string };
// Every share across the caller's sites, soonest end first (M6 R165).
export async function listShares(server: string, options: CallOptions & { siteId?: string; endingWithinDays?: number } = {}) {
  const shares: OwnerShare[] = [];
  let cursor: string | undefined;
  do {
    const page = await callTool<{ shares: OwnerShare[]; next_cursor?: string }>(server, 'list_shares', {
      ...(options.siteId ? { site_id: options.siteId } : {}), ...(options.endingWithinDays ? { ending_within_days: options.endingWithinDays } : {}), ...(cursor ? { cursor } : {}),
    }, options);
    shares.push(...page.shares);
    cursor = page.next_cursor;
  } while (cursor);
  return shares;
}

// --rule /docs/=public, --public, --shared, --private: the rules they mean.
export function parseRules(values: { public?: boolean; private?: boolean; rule?: string[] }): Rule[] | undefined {
  if (values.public) return [{ path: '/', access: ['public'] }];
  if (values.private) return [];
  if (!values.rule?.length) return undefined;
  return values.rule.map((r) => {
    const at = r.lastIndexOf('=');
    if (at < 1) throw new Error(`--rule takes <path>=<access>, such as /docs/=public, /lessons/=gold,silver or /drafts/=private, not ${r}`);
    const access = r.slice(at + 1);
    return { path: r.slice(0, at), access: access === 'private' ? 'private' : access.split(',').map((a) => a.trim()).filter(Boolean) };
  });
}
