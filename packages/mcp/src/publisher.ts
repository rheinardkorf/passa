// The publishing tools, independent of MCP. Every method acts only on the
// caller's own sites: anything else looks exactly like a site that doesn't exist.
import {
  type Config,
  type EdgeRecords,
  type Events,
  type FileEntry,
  isSiteId,
  isUploadId,
  isVersionId,
  newSiteId,
  newUploadId,
  newVersionId,
  NO_THREATS,
  NotFoundOrConflict,
  type Site,
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
  // Where a site is served. Defaults to https://<site-id>.<siteDomain>/; the local
  // proxy serves sites over http on its own port.
  siteUrl?: (siteId: string) => string;
  // Uploads are scanned by GuardDuty Malware Protection (in AWS, not locally),
  // and publish checks each file's result first.
  malwareScan?: boolean;
};

// A refusal the agent should see as it is. Anything else is reported generically.
export class ToolError extends Error {}

const NOT_FOUND = 'No site with that ID.';
const BAD_CURSOR = 'That cursor doesn\'t match this list. Call again without it to start from the beginning.';
const PARALLEL = 16;

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
};

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

async function inBatches<T>(items: T[], fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += PARALLEL) await Promise.all(items.slice(i, i + PARALLEL).map(fn));
}

export class Publisher {
  readonly #d: Deps;

  constructor(deps: Deps) {
    this.#d = deps;
  }

  #now() {
    return (this.#d.now ?? (() => new Date()))();
  }

  #url(siteId: string) {
    return this.#d.siteUrl ? this.#d.siteUrl(siteId) : `https://${siteId}.${siteDomain(this.#d.config)}/`;
  }

  #summary(site: Site): SiteSummary {
    return {
      site_id: site.id,
      url: this.#url(site.id),
      title: site.title,
      status: site.status,
      current_version: site.current,
      created_at: site.createdAt,
      updated_at: site.updatedAt,
      ...(site.dataSource ? { data_source: site.dataSource } : {}),
      ...(site.dataAsOf ? { data_as_of: site.dataAsOf } : {}),
      ...(site.purgeAt ? { delete_at: site.purgeAt } : {}),
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
    if (base) await inBatches(kept, (f) => this.#d.files.copyVersionFile(siteId, base.id, version.id, f.path));
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

  async publish(caller: Caller, input: { content: Content; title: string; dataSource?: string; dataAsOf?: string }) {
    const siteId = newSiteId();
    const { version, skipped } = await this.#storeVersion(caller, siteId, { content: input.content });
    const site: Site = {
      id: siteId,
      ownerId: caller.userId,
      title: input.title,
      ...(input.dataSource ? { dataSource: input.dataSource } : {}),
      ...(input.dataAsOf ? { dataAsOf: input.dataAsOf } : {}),
      current: version.id,
      accessVersion: 1,
      status: 'active',
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
    };
    await this.#d.store.createSite(site, version);
    await syncEdge(this.#d.edge, site);
    return { ...this.#summary(site), files: version.files.length, skipped };
  }

  // By default the new version is the current one with the changes applied.
  // With replaceAll, the files sent are the whole new version.
  // With baseVersion, the update is refused if the site has moved on from the
  // version the agent last read.
  async update(caller: Caller, input: { siteId: string; content?: Content; remove?: string[]; edits?: Edit[]; replaceAll?: boolean; baseVersion?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    if (input.baseVersion && input.baseVersion !== site.current) {
      throw new ToolError(`The site has changed since version ${input.baseVersion}: its current version is ${site.current}. Get the site again and retry.`);
    }
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
      await this.#d.store.addVersion(caller.userId, version, site.current);
    } catch (err) {
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const now = await this.#d.store.getSite(site.id);
      throw new ToolError(now?.ownerId === caller.userId && now.status === 'active'
        ? 'The site changed while this update was running. Get the site again and retry.'
        : NOT_FOUND);
    }
    const updated = { ...site, current: version.id, updatedAt: version.createdAt };
    await syncEdge(this.#d.edge, updated);
    return {
      ...this.#summary(updated),
      files: version.files.length,
      changed: version.files.length - kept,
      removed: remove.length,
      skipped,
    };
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
    const sites = (await this.#d.store.listSitesByOwner(caller.userId)).filter((s) => !query || s.title.toLowerCase().includes(query));
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
    const rolledBack = { ...site, current: input.versionId, updatedAt: now };
    await syncEdge(this.#d.edge, rolledBack);
    return this.#summary(rolledBack);
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
    await this.#d.files.deleteSite(siteId);
    await this.#d.store.deleteSiteRecords(siteId);
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
