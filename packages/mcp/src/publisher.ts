// The publishing tools, independent of MCP. Every method acts only on the
// caller's own sites: anything else looks exactly like a site that doesn't exist.
import {
  type Access,
  accessChanges,
  accessOf,
  checkRules,
  type Config,
  type EdgeRecords,
  type Events,
  type FileEntry,
  isSiteId,
  isUploadId,
  isVersionId,
  NameTaken,
  nameProblem,
  newSiteId,
  newUploadId,
  newVersionId,
  NO_THREATS,
  NotFoundOrConflict,
  regions,
  type Rule,
  type Site,
  type SiteDetails,
  type SiteFiles,
  siteDomain,
  type Store,
  syncEdge,
  THREATS,
  type Version,
} from '@passa/shared';
import { type CheckedFile, checkContent, checkManifest, type InputFile, PublishRefused } from './checks.ts';

export type Caller = { userId: string; ip?: string };

export type Deps = {
  store: Store;
  files: SiteFiles;
  events: Events;
  edge: EdgeRecords;
  config: Config;
  now?: () => Date;
  // Where a site is served, by its ID or name. Defaults to
  // https://<label>.<siteDomain>/; the local proxy serves sites over http on its own port.
  siteUrl?: (label: string) => string;
  // Uploads are scanned by GuardDuty Malware Protection (in AWS, not locally),
  // and publish checks each file's result first.
  malwareScan?: boolean;
};

// A refusal the agent should see as it is. Anything else is reported generically.
export class ToolError extends Error {}

const NOT_FOUND = 'No site with that ID.';
const BAD_CURSOR = 'That cursor doesn\'t match this list. Call again without it to start from the beginning.';
const PARALLEL = 16;
// Copies within S3 move no data through the function, so more run at once,
// staying under the SDK's default of 50 sockets.
const COPY_PARALLEL = 48;

export type SiteSummary = {
  site_id: string;
  url: string;
  title: string;
  status: Site['status'];
  current_version: string;
  created_at: string;
  updated_at: string;
  data_source?: string;
  data_as_of?: string;
  delete_at?: string;
  name?: string;
  access: Access;
  rules?: Rule[];
};

// What a change of rules did, for the response and the event (R48).
export type AccessChange = { made_public: string[]; made_private: string[] };

export type SiteFile = { path: string; size: number; content_type: string; sha256: string; content?: string; download_url?: string };

export type Content = { files: InputFile[] } | { uploadId: string };

// Replaces old with new in a text file; old must appear exactly once.
export type Edit = { path: string; old: string; new: string };

type Changes = { content?: Content; edited?: InputFile[]; base?: Version; remove?: string[] };

const isText = (f: FileEntry) => f.contentType.includes('charset=utf-8');

// Counts overlapping matches too, stopping at two: only exactly one is usable.
function occurrences(text: string, find: string): number {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1 && count < 2; at = text.indexOf(find, at + 1)) count++;
  return count;
}

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>, size = PARALLEL): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

export class Publisher {
  readonly #d: Deps;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #now() {
    return (this.#d.now ?? (() => new Date()))();
  }

  // A site's one address: its name when it has one (M2 R45, R47).
  #url(site: Pick<Site, 'id' | 'name'>) {
    const label = site.name ?? site.id;
    return this.#d.siteUrl ? this.#d.siteUrl(label) : `https://${label}.${siteDomain(this.#d.config)}/`;
  }

  #summary(site: Site): SiteSummary {
    return {
      site_id: site.id,
      url: this.#url(site),
      ...(site.name ? { name: site.name } : {}),
      title: site.title,
      status: site.status,
      current_version: site.current,
      created_at: site.createdAt,
      updated_at: site.updatedAt,
      ...(site.dataSource ? { data_source: site.dataSource } : {}),
      ...(site.dataAsOf ? { data_as_of: site.dataAsOf } : {}),
      ...(site.purgeAt ? { delete_at: site.purgeAt } : {}),
      access: accessOf(site.rules ?? []),
      ...(site.rules?.length ? { rules: site.rules } : {}),
    };
  }

  // Writes the edge record from the site as stored now, not as this call read
  // it, so a concurrent change (such as rules made private) is never undone.
  async #sync(siteId: string): Promise<Site | undefined> {
    const site = await this.#d.store.getSite(siteId);
    await (site ? syncEdge(this.#d.edge, site) : this.#d.edge.remove(siteId));
    return site;
  }

  // Checks new rules against the current ones. Anything that would become
  // public needs confirmPublic (R37), whichever way it happens.
  #checkAccess(before: Rule[], after: Rule[], confirmPublic: boolean): AccessChange {
    const problems = checkRules(after);
    if (problems.length) throw new PublishRefused(problems);
    const { madePublic, madePrivate } = accessChanges(before, after);
    if (madePublic.length && !confirmPublic) {
      throw new ToolError(`This would make ${madePublic.join(', ')} public: anyone with the link could open ${madePublic.length > 1 ? 'them' : 'it'} without signing in. `
        + 'Check with the person first, then call again with confirm_public set to true.');
    }
    return { made_public: madePublic, made_private: madePrivate };
  }

  // The public URLs, and a reminder when something was made private, since the
  // edge can take up to a minute everywhere (R40).
  #accessResult(site: Site, change: AccessChange) {
    const open = regions(site.rules ?? []).public;
    return {
      ...change,
      public_urls: open.map((p) => this.#url(site) + p.slice(1)),
      ...(change.made_private.length ? { note: 'Paths made private can stay public at some edge locations for up to a minute.' } : {}),
    };
  }

  // R8: the caller must still be an active publisher, checked on every call.
  async assertPublisher(caller: Caller): Promise<void> {
    const user = await this.#d.store.getUser(caller.userId);
    if (!user || user.status !== 'active' || !user.roles.includes('publisher')) {
      throw new ToolError('This account cannot publish.');
    }
  }

  #assertChangeable(site: Site) {
    if (site.status === 'blocked') throw new ToolError('This site is blocked because a file in it failed a malware scan. It can only be deleted.');
    if (site.status !== 'active') throw new ToolError('This site is being deleted.');
  }

  async #ownSite(caller: Caller, siteId: string): Promise<Site> {
    const site = isSiteId(siteId) ? await this.#d.store.getSite(siteId) : undefined;
    if (!site || site.ownerId !== caller.userId) throw new ToolError(NOT_FOUND);
    return site;
  }

  // Runs every check, then writes a complete new version: the files sent, plus
  // the base version's other files (copied within S3) unless removed.
  async #storeVersion(caller: Caller, siteId: string, changes: Changes): Promise<{ version: Version; skipped: string[]; kept: number }> {
    const { content, edited = [], base, remove = [] } = changes;
    const sent = !content
      ? { files: [], skipped: [] }
      : 'files' in content ? this.#checkInline(content.files) : await this.#takeUpload(caller, content.uploadId);
    const editedPaths = new Set(edited.map((f) => f.path.toLowerCase()));
    const overlap = sent.files.filter((f) => editedPaths.has(f.path.toLowerCase())).map((f) => `${f.path}: both sent and edited`);
    if (overlap.length) throw new PublishRefused(overlap);
    const { skipped } = sent;
    const checked = await checkContent([...sent.files, ...edited]);
    const replaced = new Set([...checked, ...remove.map((path) => ({ path }))].map((f) => f.path.toLowerCase()));
    const kept = (base?.files ?? []).filter((f) => !replaced.has(f.path.toLowerCase()));
    const entries = [...kept, ...checked.map((f): FileEntry => ({ path: f.path, size: f.size, contentType: f.contentType, sha256: f.sha256 }))]
      .sort((a, b) => a.path.localeCompare(b.path));
    this.#checkTotals(entries);

    const version: Version = {
      id: newVersionId(this.#now().getTime()),
      siteId,
      files: entries,
      size: entries.reduce((sum, f) => sum + f.size, 0),
      createdAt: this.#now().toISOString(),
      createdBy: caller.userId,
    };
    await inBatches(checked, (f: CheckedFile) => this.#d.files.putVersionFile(siteId, version.id, f.path, f.content, f.contentType));
    if (base) await inBatches(kept, (f) => this.#d.files.copyVersionFile(siteId, base.id, version.id, f.path), COPY_PARALLEL);
    if (content && 'uploadId' in content) await this.#d.files.deleteUpload(content.uploadId);
    return { version, skipped, kept: kept.length };
  }

  // Limits on the whole version, after changes are applied to the base.
  #checkTotals(entries: FileEntry[]) {
    const { limits } = this.#d.config;
    const problems: string[] = [];
    if (entries.length === 0) problems.push('no files left in the site');
    if (entries.length > limits.files) problems.push(`more than ${limits.files} files`);
    if (entries.reduce((sum, f) => sum + f.size, 0) > limits.site) problems.push(`larger than the ${limits.site}-byte total limit`);
    if (problems.length) throw new PublishRefused(problems);
  }

  #checkInline(files: InputFile[]) {
    const { limits } = this.#d.config;
    const { keep, skipped } = checkManifest(files.map((f) => ({ path: f.path, size: f.content.byteLength })), limits, limits.inlinePublish);
    return { files: files.filter((f) => keep.has(f.path)), skipped };
  }

  async #takeUpload(caller: Caller, uploadId: string) {
    const upload = isUploadId(uploadId) ? await this.#d.store.getUpload(uploadId, this.#now().toISOString()) : undefined;
    if (!upload || upload.ownerId !== caller.userId || upload.status === 'used') throw new ToolError('No upload with that ID.');
    if (upload.status !== 'ready') throw new ToolError('Call finish_upload first.');
    // Checked before the upload is claimed, so a file still being scanned can be retried.
    if (this.#d.malwareScan) await this.#checkScans(caller, uploadId, upload.files.map((f) => f.path));
    try {
      await this.#d.store.markUploadUsed(caller.userId, uploadId);
    } catch (err) {
      if (err instanceof NotFoundOrConflict) throw new ToolError('No upload with that ID.');
      throw err;
    }
    const files = await Promise.all(upload.files.map(async ({ path, size }) => ({ path, size, content: await this.#d.files.getUploadedFile(uploadId, path) })));
    // The upload URLs stay valid until they expire, so sizes are checked again.
    const changed = files.filter((f) => f.content.byteLength !== f.size).map((f) => `${f.path}: changed size after finish_upload`);
    if (changed.length) throw new PublishRefused(changed);
    return { files: files.map(({ path, content }) => ({ path, content })), skipped: [] };
  }

  async #checkScans(caller: Caller, uploadId: string, paths: string[]) {
    const results = await Promise.all(paths.map(async (path) => ({ path, status: await this.#d.files.uploadScanStatus(uploadId, path) })));
    const threats = results.filter((r) => r.status === THREATS);
    if (threats.length) {
      // The upload can't be used again; its files are removed now rather than at expiry.
      await this.#d.store.markUploadUsed(caller.userId, uploadId).catch(() => undefined);
      await this.#d.files.deleteUpload(uploadId);
      throw new PublishRefused(threats.map((r) => `${r.path}: malware found`));
    }
    if (results.some((r) => r.status === undefined)) throw new ToolError('Some files are still being scanned for malware. Try again in a few seconds.');
    const unscanned = results.filter((r) => r.status !== NO_THREATS);
    if (unscanned.length) throw new PublishRefused(unscanned.map((r) => `${r.path}: couldn't be scanned for malware (${r.status})`));
  }

  async publish(caller: Caller, input: { content: Content; title: string; dataSource?: string; dataAsOf?: string; rules?: Rule[]; confirmPublic?: boolean }) {
    const change = input.rules ? this.#checkAccess([], input.rules, input.confirmPublic ?? false) : undefined;
    const siteId = newSiteId();
    const { version, skipped } = await this.#storeVersion(caller, siteId, { content: input.content });
    const site: Site = {
      id: siteId,
      ownerId: caller.userId,
      title: input.title,
      ...(input.dataSource ? { dataSource: input.dataSource } : {}),
      ...(input.dataAsOf ? { dataAsOf: input.dataAsOf } : {}),
      ...(input.rules?.length ? { rules: input.rules } : {}),
      current: version.id,
      accessVersion: 1,
      status: 'active',
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
    };
    await this.#d.store.createSite(site, version);
    await this.#sync(site.id);
    return { ...this.#summary(site), files: version.files.length, skipped, ...(change ? this.#accessResult(site, change) : {}) };
  }

  // By default the new version is the current one with the changes applied.
  // With replaceAll, the files sent are the whole new version.
  // With baseVersion, the update is refused if the site has moved on from the
  // version the agent last read.
  // With rules, the site's rules are replaced along with the new version.
  // Details (title, data source and date) can change with or without files;
  // on their own they make no new version.
  async update(caller: Caller, input: {
    siteId: string;
    content?: Content;
    remove?: string[];
    edits?: Edit[];
    replaceAll?: boolean;
    baseVersion?: string;
    rules?: Rule[];
    confirmPublic?: boolean;
    details?: SiteDetails;
  }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    if (input.baseVersion && input.baseVersion !== site.current) {
      throw new ToolError(`The site has changed since version ${input.baseVersion}: its current version is ${site.current}. Get the site again and retry.`);
    }
    if (!input.content && !input.remove?.length && !input.edits?.length) {
      await this.#setDetails(caller, site, input.details ?? {});
      return { ...this.#summary((await this.#d.store.getSite(site.id)) ?? site), changed: 0, removed: 0 };
    }
    const change = input.rules ? this.#checkAccess(site.rules ?? [], input.rules, input.confirmPublic ?? false) : undefined;
    const remove = input.remove ?? [];
    const edits = input.edits ?? [];
    const base = input.replaceAll ? undefined : await this.#d.store.getVersion(site.id, site.current);
    if (base) {
      // Checked before anything is stored or an upload is claimed.
      const current = new Set(base.files.map((f) => f.path));
      const sent = new Set(input.content && 'files' in input.content ? input.content.files.map((f) => f.path) : []);
      const edited = new Set(edits.map((e) => e.path));
      const problems = [
        ...remove.filter((p) => !current.has(p)).map((p) => `${p}: not in the current version, so it can't be removed`),
        ...remove.filter((p) => sent.has(p)).map((p) => `${p}: both sent and removed`),
        ...remove.filter((p) => edited.has(p)).map((p) => `${p}: both edited and removed`),
      ];
      if (problems.length) throw new PublishRefused(problems);
    }
    const edited = base && edits.length ? await this.#applyEdits(base, edits) : [];
    const { version, skipped, kept } = await this.#storeVersion(caller, site.id, {
      ...(input.content ? { content: input.content } : {}),
      ...(base ? { base } : {}),
      edited,
      remove,
    });
    try {
      // Fails if another update landed first, so neither silently undoes the other.
      await this.#d.store.addVersion(caller.userId, version, site.current, input.rules ? { rules: input.rules, seen: site.updatedAt } : undefined);
    } catch (err) {
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const now = await this.#d.store.getSite(site.id);
      throw new ToolError(now?.ownerId === caller.userId && now.status === 'active'
        ? 'The site changed while this update was running. Get the site again and retry.'
        : NOT_FOUND);
    }
    if (input.details) await this.#setDetails(caller, site, input.details);
    const updated = (await this.#sync(site.id)) ?? site;
    return {
      ...this.#summary(updated),
      files: version.files.length,
      changed: version.files.length - kept,
      removed: remove.length,
      skipped,
      ...(change ? this.#accessResult(updated, change) : {}),
    };
  }

  async #setDetails(caller: Caller, site: Site, details: SiteDetails) {
    try {
      await this.#d.store.setDetails(caller.userId, site.id, details, this.#now().toISOString());
    } catch (err) {
      if (err instanceof NotFoundOrConflict) throw new ToolError(NOT_FOUND);
      throw err;
    }
  }

  // Applies each file's edits in order, refusing all of them if any doesn't
  // match exactly once, so nothing is half-edited.
  async #applyEdits(base: Version, edits: Edit[]): Promise<InputFile[]> {
    const problems: string[] = [];
    const byPath = new Map<string, { edit: Edit; n: number }[]>();
    edits.forEach((edit, i) => byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), { edit, n: i + 1 }]));
    const files: InputFile[] = [];
    await inBatches([...byPath], async ([path, list]) => {
      const entry = base.files.find((f) => f.path === path);
      if (!entry) return void problems.push(`${path}: not in the current version, so it can't be edited`);
      if (!isText(entry)) return void problems.push(`${path}: only text files can be edited; send the whole file instead`);
      let text = Buffer.from(await this.#d.files.getVersionFile(base.siteId, base.id, path)).toString('utf8');
      for (const { edit, n } of list) {
        const count = occurrences(text, edit.old);
        if (count !== 1) {
          return void problems.push(count === 0
            ? `${path}: edit ${n}'s old text isn't in the file`
            : `${path}: edit ${n}'s old text appears more than once; include more of the surrounding text`);
        }
        const at = text.indexOf(edit.old);
        text = text.slice(0, at) + edit.new + text.slice(at + edit.old.length);
      }
      files.push({ path, content: new TextEncoder().encode(text) });
    });
    if (problems.length) throw new PublishRefused(problems.sort());
    return files;
  }

  // Details, one page of versions, and every file's details and hash in one
  // version, but no contents.
  async getSite(caller: Caller, input: { siteId: string; versionId?: string; limit: number; cursor?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    if (input.cursor && !isVersionId(input.cursor)) throw new ToolError(BAD_CURSOR);
    const [version, page] = await Promise.all([
      this.#version(site, input.versionId),
      this.#d.store.listVersionsPage(site.id, { limit: input.limit, ...(input.cursor ? { after: input.cursor } : {}) }),
    ]);
    return {
      ...this.#summary(site),
      version: version.id,
      versions: page.versions.map((v) => ({ version_id: v.id, created_at: v.createdAt, files: v.files.length, size: v.size, current: v.id === site.current })),
      ...(page.next ? { next_cursor: page.next } : {}),
      files: version.files.map((f) => this.#fileDetails(f)),
    };
  }

  // The contents of the files asked for: text inline up to the inline limit in
  // total, and anything else (binary files, or text past the limit) as a
  // short-lived download link.
  async getFiles(caller: Caller, input: { siteId: string; versionId?: string; paths: string[] }) {
    const site = await this.#ownSite(caller, input.siteId);
    const version = await this.#version(site, input.versionId);
    const { config } = this.#d;
    const wanted = new Set(input.paths);
    const missing = [...wanted].filter((p) => !version.files.some((f) => f.path === p));
    if (missing.length) throw new ToolError(`Not in this version: ${missing.join(', ')}.`);
    let budget = config.limits.inlinePublish;
    const files = version.files.filter((f) => wanted.has(f.path)).map((f) => {
      const inline = isText(f) && f.size <= budget;
      if (inline) budget -= f.size;
      return { entry: f, inline };
    });
    return {
      site_id: site.id,
      version: version.id,
      files: await Promise.all(files.map(async ({ entry: f, inline }): Promise<SiteFile> => ({
        ...this.#fileDetails(f),
        ...(inline
          ? { content: Buffer.from(await this.#d.files.getVersionFile(version.siteId, version.id, f.path)).toString('utf8') }
          : { download_url: await this.#d.files.presignVersionFile(version.siteId, version.id, f.path, config.lifetimes.uploadUrl) }),
      }))),
    };
  }

  async #version(site: Site, versionId = site.current): Promise<Version> {
    const version = isVersionId(versionId) ? await this.#d.store.getVersion(site.id, versionId) : undefined;
    if (!version) throw new ToolError('No version with that ID.');
    return version;
  }

  #fileDetails(f: FileEntry): SiteFile {
    return { path: f.path, size: f.size, content_type: f.contentType, sha256: f.sha256 };
  }

  // Newest first, one page at a time. The cursor is the last site of the
  // previous page.
  async findSites(caller: Caller, input: { query?: string; limit: number; cursor?: string }) {
    const query = input.query?.trim().toLowerCase();
    const sites = (await this.#d.store.listSitesByOwner(caller.userId))
      .filter((s) => !query || s.title.toLowerCase().includes(query) || !!s.name?.includes(query));
    const start = input.cursor ? sites.findIndex((s) => s.id === input.cursor) + 1 : 0;
    if (input.cursor && start === 0) throw new ToolError(BAD_CURSOR);
    const page = sites.slice(start, start + input.limit);
    const more = start + input.limit < sites.length;
    return { sites: page.map((s) => this.#summary(s)), ...(more ? { next_cursor: page[page.length - 1]?.id } : {}) };
  }

  async rollback(caller: Caller, input: { siteId: string; versionId: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const now = this.#now().toISOString();
    try {
      if (!isVersionId(input.versionId)) throw new NotFoundOrConflict();
      await this.#d.store.setCurrentVersion(caller.userId, site.id, input.versionId, now);
    } catch (err) {
      if (err instanceof NotFoundOrConflict) throw new ToolError('No version with that ID.');
      throw err;
    }
    return this.#summary((await this.#sync(site.id)) ?? site);
  }

  // Replaces a site's rules (R34). The check runs against the rules as read, and
  // the write is refused if the site changed in between, so a confirmation
  // always covers what actually becomes public.
  async setAccess(caller: Caller, input: { siteId: string; rules: Rule[]; confirmPublic: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const change = this.#checkAccess(site.rules ?? [], input.rules, input.confirmPublic);
    try {
      await this.#d.store.setRules(caller.userId, site.id, input.rules, this.#now().toISOString(), site.updatedAt);
    } catch (err) {
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const now = await this.#d.store.getSite(site.id);
      throw new ToolError(now?.ownerId === caller.userId && now.status === 'active' ? 'The site changed while this was running. Get the site again and retry.' : NOT_FOUND);
    }
    const updated = (await this.#sync(site.id)) ?? site;
    return { ...this.#summary(updated), ...this.#accessResult(updated, change) };
  }

  async delete(caller: Caller, input: { siteId: string; now: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    if (input.now) {
      await this.purge(site.id);
      return { site_id: site.id, deleted: true };
    }
    if (site.status === 'deleting') return { site_id: site.id, deleted: false, delete_at: site.purgeAt };
    const now = this.#now();
    const purgeAt = new Date(now.getTime() + this.#d.config.deleteGraceDays * 86_400_000).toISOString();
    try {
      await this.#d.store.markDeleting(caller.userId, site.id, purgeAt, now.toISOString());
    } catch (err) {
      if (err instanceof NotFoundOrConflict) throw new ToolError(NOT_FOUND);
      throw err;
    }
    // The site stops being served at once; the grace period is for undoing.
    await this.#d.edge.remove(site.id);
    return { site_id: site.id, deleted: false, delete_at: purgeAt };
  }

  // Hard delete: stop serving, then files, then records, so a failure part-way
  // leaves the records in place and the purge can simply run again.
  async purge(siteId: string): Promise<void> {
    await this.#d.edge.remove(siteId);
    for (const { name } of await this.#d.store.namesOf(siteId)) await this.#d.edge.removeName(name);
    await this.#d.files.deleteSite(siteId);
    await this.#d.store.deleteSiteRecords(siteId);
  }

  // Gives a site a name, a new one, or none (M2 R44, R46). The old name is held
  // for the owner, and keeps redirecting to the site, for nameHoldDays.
  async setName(caller: Caller, input: { siteId: string; name: string | null }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const to = input.name ?? undefined;
    const problem = to && nameProblem(to, this.#d.config.reservedNames);
    if (problem) throw new ToolError(problem);
    if (to === site.name) return { ...this.#summary(site), name_change: { from: site.name ?? null, to: to ?? null } };
    const now = this.#now();
    const holdUntil = new Date(now.getTime() + this.#d.config.nameHoldDays * 86_400_000).toISOString();
    try {
      await this.#d.store.setName({ ownerId: caller.userId, siteId: site.id, ...(site.name ? { from: site.name } : {}), ...(to ? { to } : {}), now: now.toISOString(), holdUntil });
    } catch (err) {
      if (err instanceof NameTaken) throw new ToolError('That name is taken.');
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const current = await this.#d.store.getSite(site.id);
      throw new ToolError(current?.ownerId === caller.userId && current.status === 'active' ? 'The site changed while this was running. Get the site again and retry.' : NOT_FOUND);
    }
    // The new name before the site record, so its redirect has somewhere to go.
    if (to) await this.syncName(to);
    const updated = (await this.#sync(site.id)) ?? site;
    if (site.name) await this.syncName(site.name);
    return {
      ...this.#summary(updated),
      name_change: { from: site.name ?? null, to: to ?? null },
      ...(site.name ? { held: { name: site.name, until: holdUntil, note: 'The old name redirects here until then, and only you can claim it again.' } } : {}),
    };
  }

  // Writes a name's edge record from DynamoDB as it is now: pointing at its
  // site while it's current or held, and gone once its hold has ended.
  async syncName(name: string): Promise<void> {
    const record = await this.#liveName(name);
    await (record ? this.#d.edge.putName(name, record.siteId) : this.#d.edge.removeName(name));
  }

  // After DynamoDB expires a held name: removes its edge record, unless the
  // name has been claimed again since (whoever claimed it wrote the record).
  async expireName(name: string): Promise<void> {
    if (!(await this.#liveName(name))) await this.#d.edge.removeName(name);
  }

  async #liveName(name: string) {
    const record = await this.#d.store.getName(name);
    return record && (!record.heldUntil || record.heldUntil > this.#now().toISOString()) ? record : undefined;
  }

  async beginUpload(caller: Caller, input: { files: { path: string; size: number }[] }) {
    const { config } = this.#d;
    const { keep, skipped } = checkManifest(input.files, config.limits, config.limits.site);
    const files = input.files.filter((f) => keep.has(f.path));
    const now = this.#now();
    const uploadId = newUploadId();
    const expiresAt = new Date(now.getTime() + config.lifetimes.uploadUrl * 1000).toISOString();
    await this.#d.store.putUpload({ id: uploadId, ownerId: caller.userId, files, status: 'pending', createdAt: now.toISOString(), expiresAt });
    const uploads = await Promise.all(files.map(async (f) => ({
      path: f.path,
      method: 'PUT' as const,
      url: await this.#d.files.presignUpload(uploadId, f.path, f.size, config.lifetimes.uploadUrl),
      headers: { 'Content-Length': String(f.size) },
    })));
    return { upload_id: uploadId, expires_at: expiresAt, uploads, skipped };
  }

  // Confirms every listed file arrived at its declared size, so publish and
  // update can fail early and clearly.
  async finishUpload(caller: Caller, input: { uploadId: string }) {
    const upload = isUploadId(input.uploadId) ? await this.#d.store.getUpload(input.uploadId, this.#now().toISOString()) : undefined;
    if (!upload || upload.ownerId !== caller.userId || upload.status === 'used') throw new ToolError('No upload with that ID.');
    const problems: string[] = [];
    await inBatches(upload.files, async ({ path, size }) => {
      const actual = await this.#d.files.uploadedSize(upload.id, path);
      if (actual === undefined) problems.push(`${path}: not uploaded`);
      else if (actual !== size) problems.push(`${path}: uploaded ${actual} bytes, expected ${size}`);
    });
    if (problems.length) throw new PublishRefused(problems.sort());
    if (upload.status === 'pending') await this.#d.store.markUploadReady(caller.userId, upload.id);
    return { upload_id: upload.id, ready: true, files: upload.files.length };
  }
}
