// Sites from the CLI (R103–R105): which site a folder or name means, and
// reading sites through the MCP tools.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { chooseServer, readCredentials } from './auth.ts';
import { request } from './http.ts';
import { callTool, type CallOptions, ToolRefused } from './mcp.ts';

// Site IDs, as the publisher makes them (shared/ids.ts).
const SITE_ID = /^[a-z]{3,6}-[a-z]{3,6}-[b-df-hj-km-np-tv-z2-9]{6}$/;

// A folder's site, in .passa/site.yml. version is the one it was last pulled
// or synced at, for sync --base.
export type Link = { server: string; site: string; version?: string };
export const LINK_FILE = '.passa/site.yml';

export function readLink(folder: string): Link | undefined {
  const file = join(folder, LINK_FILE);
  if (!existsSync(file)) return undefined;
  const data: unknown = parseYaml(readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object') return undefined;
  const { server, site, version } = data as Record<string, unknown>;
  return typeof server === 'string' && typeof site === 'string' ? { server, site, ...(typeof version === 'string' ? { version } : {}) } : undefined;
}

export function writeLink(folder: string, link: Link): void {
  mkdirSync(join(folder, '.passa'), { recursive: true });
  writeFileSync(join(folder, LINK_FILE), `# This folder's Passa site. Dotfiles aren't published.\nserver: ${link.server}\nsite: ${link.site}\n${link.version ? `version: ${link.version}\n` : ''}`);
}

export type Target = { server: string; siteId: string; folder?: string; link?: Link };

type Summary = { site_id: string; name?: string; title: string; url: string; access: string; status: string; current_version: string };

// A folder with a link, or a site ID or name on the chosen server.
export async function resolveTarget(arg: string | undefined, options: { server?: string } & CallOptions = {}): Promise<Target> {
  const folder = resolve(arg ?? '.');
  const link = existsSync(folder) && statSync(folder).isDirectory() ? readLink(folder) : undefined;
  if (link) return { server: options.server ? chooseServer(options.server, readCredentials(options.dir)) : link.server, siteId: link.site, folder, link };
  if (!arg) throw new Error(`This folder isn't linked to a site (no ${LINK_FILE}). Give a site ID or name, or publish it first.`);
  const server = chooseServer(options.server, readCredentials(options.dir));
  // A site ID is looked up directly; anything else is a name.
  if (SITE_ID.test(arg)) {
    try {
      await callTool(server, 'get_site', { site_id: arg, limit: 1 }, options);
      return { server, siteId: arg };
    } catch (err) {
      if (!(err instanceof ToolRefused)) throw err;
    }
  }
  const found = await callTool<{ sites: Summary[] }>(server, 'find_sites', { query: arg, limit: 100 }, options);
  const site = found.sites.find((s) => s.name === arg);
  if (!site) throw new Error(`No site ${arg} on ${server}.`);
  return { server, siteId: site.site_id };
}

export const sitesList = (server: string, query: string | undefined, options: CallOptions = {}) =>
  callTool<{ sites: Summary[]; next_cursor?: string }>(server, 'find_sites', { limit: 100, ...(query ? { query } : {}) }, options);

export type SiteFile = { path: string; size: number; content_type: string; sha256: string; role?: 'source' | 'rendered'; rendered_from?: string; content?: string; download_url?: string };
export type SiteDetails = Summary & {
  rules?: { path: string; tier: string }[];
  version: string;
  versions: { version_id: string; created_at: string; files: number; size: number; current: boolean }[];
  files: SiteFile[];
  data_source?: string;
  data_as_of?: string;
  delete_at?: string;
};

export const siteDetails = (target: Target, options: CallOptions = {}) =>
  callTool<SiteDetails>(target.server, 'get_site', { site_id: target.siteId, limit: 10 }, options);

// The files a folder holds for a site: sources and plain files, and the
// read-only rules file, but not pages Passa renders from the sources.
export const folderFiles = (files: SiteFile[]) => files.filter((f) => f.role !== 'rendered' || f.path === '_passa/access.yml');

const GET_FILES_MAX = 100;

// R105: writes the site's current version into a folder that's empty, or
// already this site's.
export async function pull(target: Target, folder: string, options: CallOptions = {}): Promise<{ files: number; version: string }> {
  const dest = resolve(folder);
  if (existsSync(dest)) {
    const link = readLink(dest);
    const empty = readdirSync(dest).filter((f) => f !== '.DS_Store').length === 0;
    if (!empty && link?.site !== target.siteId) throw new Error(`${dest} has files and isn't linked to ${target.siteId}; pull into an empty folder.`);
  }
  const details = await siteDetails(target, options);
  const wanted = folderFiles(details.files);
  for (let i = 0; i < wanted.length; i += GET_FILES_MAX) {
    const batch = wanted.slice(i, i + GET_FILES_MAX);
    const got = await callTool<{ files: SiteFile[] }>(target.server, 'get_files', { site_id: target.siteId, version_id: details.version, paths: batch.map((f) => f.path) }, options);
    for (const f of got.files) {
      let body: string | Buffer;
      if (f.content !== undefined) body = f.content;
      else if (f.download_url) {
        const reply = await request(f.download_url);
        if (reply.status !== 200) throw new Error(`Couldn't download ${f.path} (HTTP ${reply.status}).`);
        body = reply.body;
      } else continue;
      const path = join(dest, f.path);
      if (!path.startsWith(dest + sep)) throw new Error(`${f.path} isn't inside the folder`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
  }
  writeLink(dest, { server: target.server, site: target.siteId, version: details.version });
  return { files: wanted.length, version: details.version };
}
