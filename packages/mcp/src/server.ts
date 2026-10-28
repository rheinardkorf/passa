// The publishing MCP server: strict schemas for every tool (R9), the publisher
// check on every call (R8), and an event for every outcome (R31). Built per
// request for one authenticated caller; token checks happen before this.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_PATH_LENGTH, PublishRefused } from './checks.ts';
import { type Caller, type Content, type Deps, Publisher, ToolError } from './publisher.ts';

export type Log = (msg: string, data?: Record<string, unknown>) => void;

const path = z.string().min(1).max(MAX_PATH_LENGTH);
const siteId = z.string().max(64).describe('The site ID returned by publish');
const versionId = z.string().max(64);
const uploadId = z.string().max(64).describe('From begin_upload, after finish_upload');

const inlineFile = z.strictObject({
  path,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8').describe('base64 for binary files such as images'),
});
const inlineFiles = z.array(inlineFile).min(1).max(1000).describe('The files, for sites up to the inline size limit. Use begin_upload for larger sites');

const exactlyOne = (v: { files?: unknown; upload_id?: unknown }) => (v.files === undefined) !== (v.upload_id === undefined);
const exactlyOneMessage = { message: 'Give either files or upload_id' };

const schemas = {
  publish: z.strictObject({
    files: inlineFiles.optional(),
    upload_id: uploadId.optional(),
    title: z.string().trim().min(1).max(200),
    data_source: z.string().max(500).optional().describe('Where the data on the page came from'),
    data_as_of: z.iso.datetime({ offset: true }).optional().describe('When that data was current'),
  }).refine(exactlyOne, exactlyOneMessage),
  update: z.strictObject({
    site_id: siteId,
    files: inlineFiles.optional().describe('Files to add or replace. Files not listed stay as they are, unless replace_all is true'),
    upload_id: uploadId.optional(),
    remove: z.array(path).min(1).max(1000).optional().describe('Paths to remove from the site'),
    replace_all: z.boolean().default(false).describe('Make the files sent the whole site, removing everything else'),
  })
    .refine((v) => !(v.files && v.upload_id), exactlyOneMessage)
    .refine((v) => v.files || v.upload_id || v.remove, { message: 'Give files, upload_id or remove' })
    .refine((v) => !v.replace_all || ((v.files || v.upload_id) && !v.remove), { message: 'replace_all needs files or upload_id, and no remove' }),
  get_site: z.strictObject({ site_id: siteId, version_id: versionId.optional().describe('Defaults to the current version') }),
  find_sites: z.strictObject({ query: z.string().max(200).optional().describe('Matched against titles; omit to list every site') }),
  rollback: z.strictObject({ site_id: siteId, version_id: versionId.describe('A version listed by get_site') }),
  delete: z.strictObject({
    site_id: siteId,
    now: z.boolean().default(false).describe(`Delete immediately and permanently instead of after the grace period`),
  }),
  begin_upload: z.strictObject({
    files: z.array(z.strictObject({ path, size: z.number().int().nonnegative() })).min(1).max(1000),
  }),
  finish_upload: z.strictObject({ upload_id: uploadId }),
};

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const refusal = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

function decode(files: z.infer<typeof inlineFile>[]) {
  return files.map((f) => ({ path: f.path, content: new Uint8Array(Buffer.from(f.content, f.encoding)) }));
}

const content = (input: { files?: z.infer<typeof inlineFile>[] | undefined; upload_id?: string | undefined }): Content =>
  input.files ? { files: decode(input.files) } : { uploadId: input.upload_id ?? '' };

export function createServer(deps: Deps, caller: Caller, log: Log): McpServer {
  const publisher = new Publisher(deps);
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
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean },
    schema: S,
    run: (input: z.infer<S>) => Promise<{ result: unknown; siteId?: string }>,
  ) {
    // The schema is widened here only to keep the SDK's generics concrete; it
    // still parses every input, and run() gets the parsed result.
    server.registerTool(name, { description, inputSchema: schema as z.ZodType, annotations }, async (input) => {
      const base = { ...event, action: name };
      try {
        await publisher.assertPublisher(caller);
        const { result, siteId } = await run(input as z.infer<S>);
        if (!annotations.readOnlyHint) await deps.events.record({ ...base, result: 'ok', ...(siteId ? { siteId } : {}) });
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

  tool('publish', 'Publish files as a new private site. Returns its URL, which only you can open after signing in.', {}, schemas.publish, async (i) => {
    const r = await publisher.publish(caller, {
      content: content(i),
      title: i.title,
      ...(i.data_source ? { dataSource: i.data_source } : {}),
      ...(i.data_as_of ? { dataAsOf: i.data_as_of } : {}),
    });
    return { result: r, siteId: r.site_id };
  });

  tool('update', 'Change a site by sending only the files that changed, and listing any to remove; everything else stays. The URL stays the same, and earlier versions are kept for rollback.', {}, schemas.update, async (i) => {
    const r = await publisher.update(caller, {
      siteId: i.site_id,
      ...(i.files || i.upload_id ? { content: content(i) } : {}),
      ...(i.remove ? { remove: i.remove } : {}),
      replaceAll: i.replace_all,
    });
    return { result: r, siteId: r.site_id };
  });

  tool('get_site', 'Get a site\'s details, its versions, and the files of one version, so you can continue working on it.', { readOnlyHint: true }, schemas.get_site, async (i) => ({
    result: await publisher.getSite(caller, { siteId: i.site_id, ...(i.version_id ? { versionId: i.version_id } : {}) }),
  }));

  tool('find_sites', 'List your sites, optionally matching a title.', { readOnlyHint: true }, schemas.find_sites, async (i) => ({
    result: await publisher.findSites(caller, i.query ? { query: i.query } : {}),
  }));

  tool('rollback', 'Make an earlier version of a site current again. Takes effect immediately.', { idempotentHint: true }, schemas.rollback, async (i) => {
    const r = await publisher.rollback(caller, { siteId: i.site_id, versionId: i.version_id });
    return { result: r, siteId: r.site_id };
  });

  tool('delete', 'Delete a site. By default it is removed after a grace period; with now=true it is removed immediately and permanently.', { destructiveHint: true }, schemas.delete, async (i) => {
    const r = await publisher.delete(caller, { siteId: i.site_id, now: i.now });
    return { result: r, siteId: r.site_id };
  });

  tool('begin_upload', 'Start an upload for a site too large to send inline. Returns a URL per file: PUT each file to its URL, then call finish_upload.', {}, schemas.begin_upload, async (i) => ({
    result: await publisher.beginUpload(caller, i),
  }));

  tool('finish_upload', 'Confirm an upload is complete. Then pass its upload_id to publish or update.', { idempotentHint: true }, schemas.finish_upload, async (i) => ({
    result: await publisher.finishUpload(caller, { uploadId: i.upload_id }),
  }));

  return server;
}
