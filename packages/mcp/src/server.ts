// The publishing MCP server: strict schemas for every tool (R9), the publisher
// check on every call (R8), and an event for every outcome (R31). Built per
// request for one authenticated caller; token checks happen before this.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_PATH_LENGTH, PublishRefused } from './checks.ts';
import { type Config, MAX_RULE_PATH } from '@passa/shared';
import { type AccessChange, type Caller, type Content, type Deps, Publisher, ToolError } from './publisher.ts';

export type Log = (msg: string, data?: Record<string, unknown>) => void;

const MAX_PAGE = 100;

const path = z.string().min(1).max(MAX_PATH_LENGTH);
const siteId = z.string().max(64).describe('The site ID returned by publish');
const versionId = z.string().max(64);
const uploadId = z.string().max(64).describe('From begin_upload, after finish_upload');
const limit = (what: string, fallback: number) => z.number().int().min(1).max(MAX_PAGE).default(fallback).describe(`How many ${what} to return, up to ${MAX_PAGE}`);
const cursor = z.string().max(64).optional().describe('next_cursor from the previous call, to get the next page');

const inlineFile = z.strictObject({
  path,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8').describe('base64 for binary files such as images'),
});
const inlineFiles = z.array(inlineFile).min(1).max(1000).describe('The files, for sites up to the inline size limit. Use begin_upload for larger sites');
const rules = z.array(z.strictObject({
  path: z.string().min(1).max(MAX_RULE_PATH).describe('/ for the whole site, or a folder ending in /, such as /docs/'),
  tier: z.enum(['private', 'public']).describe('public: anyone with the link, without signing in. private: only you'),
})).max(100).describe('Who can open which paths. The longest matching path decides; anything no rule covers is private');
const confirmPublic = z.boolean().default(false).describe('Must be true when the rules make anything public. Ask the person first');

const edit = z.strictObject({
  path,
  old: z.string().min(1).describe('Text to replace, exactly as it is in the file. It must appear exactly once, so include enough of the surrounding text'),
  new: z.string().describe('The text to put in its place'),
});

const exactlyOne = (v: { files?: unknown; upload_id?: unknown }) => (v.files === undefined) !== (v.upload_id === undefined);
const exactlyOneMessage = { message: 'Give either files or upload_id' };

const schemas = {
  publish: z.strictObject({
    files: inlineFiles.optional(),
    upload_id: uploadId.optional(),
    title: z.string().trim().min(1).max(200),
    data_source: z.string().max(500).optional().describe('Where the data on the page came from'),
    data_as_of: z.iso.datetime({ offset: true }).optional().describe('When that data was current'),
    rules: rules.optional().describe('Who can open which paths; without rules the site is private. See set_access'),
    confirm_public: confirmPublic,
  }).refine(exactlyOne, exactlyOneMessage),
  update: z.strictObject({
    site_id: siteId,
    files: inlineFiles.optional().describe('Files to add or replace. Files not listed stay as they are, unless replace_all is true'),
    upload_id: uploadId.optional(),
    remove: z.array(path).min(1).max(1000).optional().describe('Paths to remove from the site'),
    edits: z.array(edit).min(1).max(100).optional().describe('Small changes to text files, applied in order. If any edit doesn\'t match, none are applied'),
    base_version: versionId.optional().describe('The version you last read, from get_site or get_files. The update is refused if the site has changed since'),
    replace_all: z.boolean().default(false).describe('Make the files sent the whole site, removing everything else'),
    rules: rules.optional().describe('Replaces the site\'s rules along with the files; without rules they stay as they are. See set_access'),
    confirm_public: confirmPublic,
    title: z.string().trim().min(1).max(200).optional().describe('A new title'),
    data_source: z.string().max(500).nullable().optional().describe('Where the data on the page came from; null removes it'),
    data_as_of: z.iso.datetime({ offset: true }).nullable().optional().describe('When that data was current; null removes it'),
  })
    .refine((v) => !(v.files && v.upload_id), exactlyOneMessage)
    .refine((v) => v.files || v.upload_id || v.remove || v.edits || v.title || v.data_source !== undefined || v.data_as_of !== undefined, {
      message: 'Give files, upload_id, remove, edits, or details to change',
    })
    .refine((v) => !v.rules || v.files || v.upload_id || v.remove || v.edits, { message: 'To change only the rules, use set_access' })
    .refine((v) => !v.replace_all || ((v.files || v.upload_id) && !v.remove && !v.edits), { message: 'replace_all needs files or upload_id, and no remove or edits' }),
  get_site: z.strictObject({
    site_id: siteId,
    version_id: versionId.optional().describe('Whose files to list. Defaults to the current version'),
    limit: limit('versions', 20),
    cursor,
  }),
  get_files: z.strictObject({
    site_id: siteId,
    paths: z.array(path).min(1).max(100).describe('Paths of the files to get, as listed by get_site'),
    version_id: versionId.optional().describe('Defaults to the current version'),
  }),
  find_sites: z.strictObject({
    query: z.string().max(200).optional().describe('Matched against titles; omit to list every site'),
    limit: limit('sites', 50),
    cursor,
  }),
  set_access: z.strictObject({ site_id: siteId, rules, confirm_public: confirmPublic }),
  rollback: z.strictObject({ site_id: siteId, version_id: versionId.describe('A version listed by get_site') }),
  delete: z.strictObject({
    site_id: siteId,
    now: z.boolean().default(false).describe('Delete immediately and permanently instead of after the grace period'),
  }),
  begin_upload: z.strictObject({
    files: z.array(z.strictObject({ path, size: z.number().int().nonnegative() })).min(1).max(1000),
  }),
  finish_upload: z.strictObject({ upload_id: uploadId }),
};

// The event detail for a change of rules (R46): what became public or private.
function accessDetail(result: object): { detail?: string } {
  const r: Partial<AccessChange> = result;
  if (!r.made_public && !r.made_private) return {};
  const list = (paths: string[] | undefined) => (paths?.length ? paths.join(', ') : 'nothing');
  return { detail: `made public: ${list(r.made_public)}; made private: ${list(r.made_private)}`.slice(0, 500) };
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const refusal = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

function decode(files: z.infer<typeof inlineFile>[]) {
  return files.map((f) => ({ path: f.path, content: new Uint8Array(Buffer.from(f.content, f.encoding)) }));
}

const content = (input: { files?: z.infer<typeof inlineFile>[] | undefined; upload_id?: string | undefined }): Content =>
  input.files ? { files: decode(input.files) } : { uploadId: input.upload_id ?? '' };

function size(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${+(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

// Descriptions state this deployment's actual limits, so agents don't have to guess.
function descriptions({ limits, lifetimes, deleteGraceDays }: Config) {
  const inline = size(limits.inlinePublish);
  const minutes = `${Math.round(lifetimes.uploadUrl / 60)} minutes`;
  const sizes = `Limits: ${limits.files} files, ${size(limits.file)} per file, ${size(limits.site)} per site.`;
  return {
    publish: `Publish files as a new site. It's private unless you pass rules: only you can open it, after signing in. Send files inline up to ${inline} in total; for larger sites, or files you can read from disk (such as images), use begin_upload instead. ${sizes}`,
    update: `Change a site; everything not changed stays, and the URL stays the same. Send only the files that changed, list any to remove, or use edits for small changes to text files. Change the title or data details with or without files. Pass base_version to be refused if the site changed since you read it. Earlier versions are kept for rollback. ${sizes}`,
    set_access: 'Set who can open which parts of a site, replacing its rules. Each rule is / or a folder ending in /, and a tier: public (anyone with the link, without signing in) or private (only you). '
      + 'The longest matching rule decides, and anything no rule covers is private, so rules: [] makes the whole site private. '
      + 'Before making anything public, check with the person: confirm_public must be true for any change that makes something public. '
      + 'Changes take effect within seconds, and everywhere within about a minute.',
    get_site: 'Get a site\'s details, its versions newest first, and the files of one version with their sizes and SHA-256 hashes, but not their contents. Use get_files to read files. If next_cursor is returned, pass it as cursor for older versions.',
    find_sites: 'List your sites newest first, optionally matching a title. If next_cursor is returned, pass it as cursor for the next page.',
    get_files: `Get the contents of a site's files. Text files come back as text, up to ${inline} in total; binary files, and text past that, come back as download links valid for ${minutes}. To change a few words, use update with edits instead of resending the file.`,
    delete: `Delete a site. It stops being served at once, and is removed permanently after ${deleteGraceDays} days, or immediately with now=true.`,
    begin_upload: `Start an upload, for sites over ${inline} or files you can read from disk. Returns a URL per file, valid for ${minutes}: PUT each file's bytes to its URL (for example, curl -T path/to/file '<url>'), then call finish_upload. File contents never pass through the conversation. ${sizes}`,
  };
}

export function createServer(deps: Deps, caller: Caller, log: Log): McpServer {
  const publisher = new Publisher(deps);
  const describe = descriptions(deps.config);
  const server = new McpServer({ name: 'passa', version: '0.1.0' }, { maxToolInputElements: 10_000 });
  const event = { userId: caller.userId, ...(caller.ip ? { ip: caller.ip } : {}) };

  // The SDK validates input before calling a tool, so rejected inputs never
  // reach the wrapper below. This hook records them too (R31). A test guards
  // it, since it relies on an SDK internal.
  const sdk = server as unknown as { validateToolInput: (tool: unknown, args: unknown, name: string) => Promise<unknown> };
  const validate = sdk.validateToolInput.bind(server);
  sdk.validateToolInput = async (tool, args, name) => {
    try {
      return await validate(tool, args, name);
    } catch (err) {
      await deps.events.record({ ...event, action: name, result: 'refused', detail: 'invalid input' });
      throw err;
    }
  };

  // Wraps a tool: checks the caller, records the outcome, and keeps internal
  // errors out of responses.
  function tool<S extends z.ZodType>(
    name: keyof typeof schemas & string,
    description: string,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean },
    schema: S,
    run: (input: z.infer<S>) => Promise<{ result: unknown; siteId?: string; detail?: string }>,
  ) {
    // The schema is widened here only to keep the SDK's generics concrete; it
    // still parses every input, and run() gets the parsed result.
    server.registerTool(name, { description, inputSchema: schema as z.ZodType, annotations }, async (input) => {
      const base = { ...event, action: name };
      try {
        await publisher.assertPublisher(caller);
        const { result, siteId, detail } = await run(input as z.infer<S>);
        if (!annotations.readOnlyHint) await deps.events.record({ ...base, result: 'ok', ...(siteId ? { siteId } : {}), ...(detail ? { detail } : {}) });
        return json(result);
      } catch (err) {
        if (err instanceof ToolError || err instanceof PublishRefused) {
          await deps.events.record({ ...base, result: 'refused', detail: err.message.slice(0, 500) });
          return refusal(err.message);
        }
        log('tool failed', { tool: name, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
        await deps.events.record({ ...base, result: 'error' }).catch(() => undefined);
        return refusal('Something went wrong. Try again.');
      }
    });
  }

  tool('publish', describe.publish, {}, schemas.publish, async (i) => {
    const r = await publisher.publish(caller, {
      content: content(i),
      title: i.title,
      ...(i.data_source ? { dataSource: i.data_source } : {}),
      ...(i.data_as_of ? { dataAsOf: i.data_as_of } : {}),
      ...(i.rules ? { rules: i.rules } : {}),
      confirmPublic: i.confirm_public,
    });
    return { result: r, siteId: r.site_id, ...accessDetail(r) };
  });

  tool('update', describe.update, {}, schemas.update, async (i) => {
    const r = await publisher.update(caller, {
      siteId: i.site_id,
      ...(i.files || i.upload_id ? { content: content(i) } : {}),
      ...(i.remove ? { remove: i.remove } : {}),
      ...(i.edits ? { edits: i.edits } : {}),
      ...(i.base_version ? { baseVersion: i.base_version } : {}),
      ...(i.rules ? { rules: i.rules } : {}),
      confirmPublic: i.confirm_public,
      replaceAll: i.replace_all,
      details: {
        ...(i.title ? { title: i.title } : {}),
        ...(i.data_source !== undefined ? { dataSource: i.data_source } : {}),
        ...(i.data_as_of !== undefined ? { dataAsOf: i.data_as_of } : {}),
      },
    });
    return { result: r, siteId: r.site_id, ...accessDetail(r) };
  });

  tool('set_access', describe.set_access, { destructiveHint: true, idempotentHint: true, openWorldHint: true }, schemas.set_access, async (i) => {
    const r = await publisher.setAccess(caller, { siteId: i.site_id, rules: i.rules, confirmPublic: i.confirm_public });
    return { result: r, siteId: r.site_id, ...accessDetail(r) };
  });

  tool('get_site', describe.get_site, { readOnlyHint: true }, schemas.get_site, async (i) => ({
    result: await publisher.getSite(caller, {
      siteId: i.site_id,
      limit: i.limit,
      ...(i.version_id ? { versionId: i.version_id } : {}),
      ...(i.cursor ? { cursor: i.cursor } : {}),
    }),
  }));

  tool('get_files', describe.get_files, { readOnlyHint: true }, schemas.get_files, async (i) => ({
    result: await publisher.getFiles(caller, { siteId: i.site_id, paths: i.paths, ...(i.version_id ? { versionId: i.version_id } : {}) }),
  }));

  tool('find_sites', describe.find_sites, { readOnlyHint: true }, schemas.find_sites, async (i) => ({
    result: await publisher.findSites(caller, {
      limit: i.limit,
      ...(i.query ? { query: i.query } : {}),
      ...(i.cursor ? { cursor: i.cursor } : {}),
    }),
  }));

  tool('rollback', 'Make an earlier version of a site current again. Takes effect immediately.', { idempotentHint: true }, schemas.rollback, async (i) => {
    const r = await publisher.rollback(caller, { siteId: i.site_id, versionId: i.version_id });
    return { result: r, siteId: r.site_id };
  });

  tool('delete', describe.delete, { destructiveHint: true }, schemas.delete, async (i) => {
    const r = await publisher.delete(caller, { siteId: i.site_id, now: i.now });
    return { result: r, siteId: r.site_id };
  });

  tool('begin_upload', describe.begin_upload, {}, schemas.begin_upload, async (i) => ({
    result: await publisher.beginUpload(caller, i),
  }));

  tool('finish_upload', 'Confirm an upload is complete. Then pass its upload_id to publish or update.', { idempotentHint: true }, schemas.finish_upload, async (i) => ({
    result: await publisher.finishUpload(caller, { uploadId: i.upload_id }),
  }));

  return server;
}
