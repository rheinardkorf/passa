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
  NotFoundOrConflict,
  type Site,
  type SiteFiles,
  siteDomain,
  type Store,
  syncEdge,
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
};

// A refusal the agent should see as it is. Anything else is reported generically.
export class ToolError extends Error {}

const NOT_FOUND = 'No site with that ID.';
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

export type SiteContent = { files: ({ path: string; size: number; content_type: string } & ({ content: string; encoding: 'utf8' | 'base64' } | { download_url: string }))[] };

export type Content = { files: InputFile[] } | { uploadId: string };

type Changes = { content?: Content; base?: Version; remove?: string[] };

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

  async #ownSite(caller: Caller, siteId: string): Promise<Site> {
    const site = isSiteId(siteId) ? await this.#d.store.getSite(siteId) : undefined;
    if (!site || site.ownerId !== caller.userId) throw new ToolError(NOT_FOUND);
    return site;
  }

  // Runs every check, then writes a complete new version: the files sent, plus
  // the base version's other files (copied within S3) unless removed.
  async #storeVersion(caller: Caller, siteId: string, changes: Changes): Promise<{ version: Version; skipped: string[]; kept: number }> {
    const { content, base, remove = [] } = changes;
    const { files, skipped } = !content
      ? { files: [], skipped: [] }
      : 'files' in content ? this.#checkInline(content.files) : await this.#takeUpload(caller, content.uploadId);
    const checked = await checkContent(files);
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
  async update(caller: Caller, input: { siteId: string; content?: Content; remove?: string[]; replaceAll?: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    if (site.status !== 'active') throw new ToolError('This site is being deleted.');
    const remove = input.remove ?? [];
    const base = input.replaceAll ? undefined : await this.#d.store.getVersion(site.id, site.current);
    if (base) {
      // Checked before anything is stored or an upload is claimed.
      const current = new Set(base.files.map((f) => f.path));
      const sent = new Set(input.content && 'files' in input.content ? input.content.files.map((f) => f.path) : []);
      const problems = [
        ...remove.filter((p) => !current.has(p)).map((p) => `${p}: not in the current version, so it can't be removed`),
        ...remove.filter((p) => sent.has(p)).map((p) => `${p}: both sent and removed`),
      ];
      if (problems.length) throw new PublishRefused(problems);
    }
    const { version, skipped, kept } = await this.#storeVersion(caller, site.id, {
      ...(input.content ? { content: input.content } : {}),
      ...(base ? { base } : {}),
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

  async getSite(caller: Caller, input: { siteId: string; versionId?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    const versions = await this.#d.store.listVersions(site.id);
    const versionId = input.versionId ?? site.current;
    const version = versions.find((v) => v.id === versionId);
    if (!version) throw new ToolError('No version with that ID.');
    return {
      ...this.#summary(site),
      version: version.id,
      versions: versions.map((v) => ({ version_id: v.id, created_at: v.createdAt, files: v.files.length, size: v.size, current: v.id === site.current })),
      ...(await this.#content(version)),
    };
  }

  // Small versions come back inline so any agent can continue the site; larger
  // ones come back as short-lived download links.
  async #content(version: Version): Promise<SiteContent> {
    const { config } = this.#d;
    const inline = version.size <= config.limits.inlinePublish;
    const files: SiteContent['files'] = [];
    await inBatches(version.files, async (f) => {
      const meta = { path: f.path, size: f.size, content_type: f.contentType };
      if (!inline) {
        files.push({ ...meta, download_url: await this.#d.files.presignVersionFile(version.siteId, version.id, f.path, config.lifetimes.uploadUrl) });
        return;
      }
      const body = await this.#d.files.getVersionFile(version.siteId, version.id, f.path);
      const text = f.contentType.includes('charset=utf-8');
      files.push({ ...meta, content: Buffer.from(body).toString(text ? 'utf8' : 'base64'), encoding: text ? 'utf8' : 'base64' });
    });
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files };
  }

  async findSites(caller: Caller, input: { query?: string }) {
    const query = input.query?.trim().toLowerCase();
    const sites = await this.#d.store.listSitesByOwner(caller.userId);
    return { sites: sites.filter((s) => !query || s.title.toLowerCase().includes(query)).map((s) => this.#summary(s)) };
  }

  async rollback(caller: Caller, input: { siteId: string; versionId: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    if (site.status !== 'active') throw new ToolError('This site is being deleted.');
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
