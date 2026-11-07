// The publishing MCP server: strict schemas for every tool (R9), the publisher
// check on every call (R8), and an event for every outcome (R31). Built per
// request for one authenticated caller; token checks happen before this.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { MAX_PATH_LENGTH, PublishRefused } from './checks.ts';
import { THEME_GUIDE } from '@passa/render';
import { type Config, MAX_RULE_PATH } from '@passa/shared';
import { type AccessChange, type Caller, type Content, type Deps, Publisher, ToolError } from './publisher.ts';

export type Log = (msg: string, data?: Record<string, unknown>) => void;

const MAX_PAGE = 100;

const path = z.string().min(1).max(MAX_PATH_LENGTH);
const siteId = z.string().max(64).describe('The site ID returned by publish');
const versionId = z.string().max(64);
const uploadId = z.string().max(64).describe('From begin_upload, after finish_upload');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/).describe('The file\'s SHA-256, in lowercase hex');
const limit = (what: string, fallback: number) => z.number().int().min(1).max(MAX_PAGE).default(fallback).describe(`How many ${what} to return, up to ${MAX_PAGE}`);
const cursor = z.string().max(64).optional().describe('next_cursor from the previous call, to get the next page');
// Members and shares page by their last key, which holds emails and paths.
const keyCursor = z.string().max(2048).optional().describe('next_cursor from the previous call, to get the next page');
const email = z.email().max(254);
const startsAt = z.iso.datetime({ offset: true }).optional();

const inlineFile = z.strictObject({
  path,
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).default('utf8').describe('base64 for binary files such as images'),
});
const inlineFiles = z.array(inlineFile).min(1).max(1000).describe('The files, for sites up to the inline size limit. Use begin_upload for larger sites');
const rulePath = z.string().min(1).max(MAX_RULE_PATH).describe('/ for the whole site, or a folder ending in /, such as /docs/');
// M6: access is a list of audiences, or private.
const rules = z.array(z.strictObject({
  path: rulePath,
  access: z.union([z.literal('private'), z.array(z.string().max(30)).min(1).max(20)])
    .describe('[public]: anyone with the link, without signing in. A list of tiers, such as [gold, silver]: members of any of them, after signing in. private: only you (and anyone you share it with), to close a path inside a more open folder'),
})).max(100).describe('Who can open which paths. The longest matching path decides; anything no rule covers is private. You always open everything');
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
    sync: z.boolean().default(false).describe('With an upload_id from begin_upload with site_id: make the site exactly that folder, removing files that aren\'t in it'),
  })
    .refine((v) => !(v.files && v.upload_id), exactlyOneMessage)
    .refine((v) => !v.sync || (v.upload_id && !v.files && !v.remove && !v.edits && !v.replace_all), { message: 'sync needs upload_id, and no files, remove, edits or replace_all' })
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
    query: z.string().max(200).optional().describe('Matched against titles and names; omit to list every site'),
    limit: limit('sites', 50),
    cursor,
  }),
  set_access: z.strictObject({ site_id: siteId, rules, confirm_public: confirmPublic }),
  share: z.strictObject({
    site_id: siteId,
    email: z.email().max(254).describe('The email to share with, exactly as the person gave it'),
    path: z.string().max(MAX_RULE_PATH).regex(/^\/(?:[^/]+\/)*$/).default('/').describe('/ or a folder ending in /: what the email may open, with shared folders under it. It gets a shared rule of its own unless it\'s public'),
    starts_at: startsAt.describe('When the share begins; without it, at once'),
    expires_at: z.iso.datetime({ offset: true }).optional().describe('When the share ends: at least an hour and at most a year ahead. Without it, 90 days after it begins. Sharing again renews it'),
    confirm_share: z.boolean().default(false).describe('Must be true. Read the email back to the person first, since a typo shares private pages with a stranger'),
  }),
  unshare: z.strictObject({
    site_id: siteId,
    email: z.email().max(254),
    path: z.string().max(MAX_RULE_PATH).optional().describe('One shared path to take away; without it, every path shared with the email'),
  }),
  list_access: z.strictObject({ site_id: siteId }),
  add_member: z.strictObject({
    site_id: siteId,
    email: email.describe('The email to add, exactly as the person gave it'),
    tier: z.string().max(30).describe('The tier, such as gold: 1 to 30 lowercase letters, digits and hyphens. Rules list the tiers that open each path'),
    starts_at: startsAt.describe('When the membership begins; without it, at once'),
    expires_at: z.iso.datetime({ offset: true }).optional().describe('When the membership ends; without it, it lasts until removed'),
    confirm_member: z.boolean().default(false).describe('Must be true. Read the email back to the person first, since a typo gives members\' pages to a stranger'),
  }),
  remove_member: z.strictObject({
    site_id: siteId,
    email,
    tier: z.string().max(30).optional().describe('One tier to remove them from; without it, every tier'),
  }),
  list_members: z.strictObject({
    site_id: siteId,
    tier: z.string().max(30).optional().describe('Only this tier\'s members'),
    limit: limit('members', 100),
    cursor: keyCursor,
  }),
  list_shares: z.strictObject({
    site_id: siteId.optional().describe('Only this site\'s shares; without it, every site\'s'),
    ending_within_days: z.number().int().min(1).max(366).optional().describe('Only shares ending within this many days'),
    limit: limit('shares', 100),
    cursor: keyCursor,
  }),
  set_name: z.strictObject({
    site_id: siteId,
    name: z.string().max(40).nullable().describe('The new name, such as cv for cv.<site domain>; null removes the name'),
  }),
  rollback: z.strictObject({
    site_id: siteId,
    version_id: versionId.describe('A version listed by get_site'),
    confirm_public: confirmPublic.describe('On a Markdown site: must be true if the version has a page marked access: private that the current rules make public. Ask the person first'),
  }),
  delete: z.strictObject({
    site_id: siteId,
    now: z.boolean().default(false).describe('Delete immediately and permanently instead of after the grace period'),
  }),
  begin_upload: z.strictObject({
    files: z.array(z.strictObject({
      path,
      size: z.number().int().nonnegative(),
      sha256: sha256.optional().describe('The file\'s SHA-256, in lowercase hex. With site_id, a file whose path, size and hash match the current version isn\'t uploaded again'),
    })).min(1).max(1000).describe('Every file to publish; with site_id, every file in the folder'),
    site_id: siteId.optional().describe('To sync a folder to this site: only new and changed files get upload URLs, and files the folder doesn\'t have are listed for removal. Then call update with the upload_id and sync: true'),
  }),
  finish_upload: z.strictObject({ upload_id: uploadId }),
  theme_guide: z.strictObject({}),
};

// The event detail for a change of rules (R48): what became public or private.
function accessDetail(result: object, prefix = ''): { detail?: string } {
  const r: Partial<AccessChange> = result;
  if (!r.made_public && !r.made_private) return prefix ? { detail: prefix.slice(0, 500) } : {};
  const list = (paths: string[] | undefined) => (paths?.length ? paths.join(', ') : 'nothing');
  return { detail: `${prefix ? `${prefix}; ` : ''}made public: ${list(r.made_public)}; for members: ${list(r.made_members)}; made private: ${list(r.made_private)}`.slice(0, 500) };
}

// Text (such as the theme guide) is returned as it is; anything else as JSON.
const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
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
function descriptions({ limits, lifetimes, deleteGraceDays, nameHoldDays, retention, rateLimits }: Config) {
  const inline = size(limits.inlinePublish);
  const minutes = `${Math.round(lifetimes.uploadUrl / 60)} minutes`;
  const sizes = `Limits: ${limits.files} files, ${size(limits.file)} per file, ${size(limits.site)} per site.`;
  const markdown = 'Markdown files (.md) are rendered to pages when published: index.md becomes /, notes/plan.md becomes /notes/plan/, with a default theme, lists of pages, tag pages and, for public dated pages, a feed. '
    + 'Front matter sets the title, date, tags, layout and more; wikilinks like [[Plan]] link pages by title; fenced blocks such as ```chart or ```cards render as widgets. '
    + 'A site can mix Markdown with HTML and other files. Front matter access never makes a page public: only rules do. Call theme_guide before writing a theme (_layouts/), widgets or front matter beyond the basics. '
    + 'Public pages get social cards, drawn by Passa; cards already drawn by passa render (the _card-<hash>.png files beside its pages) can be sent with the site, and Passa keeps those its pages name instead of drawing them.';
  const kept = `Every version is kept for ${retention.versionDays} days${retention.monthEndMonths ? `, then only the last version of each month, for ${retention.monthEndMonths} months` : ''}; the current version is always kept.`;
  return {
    publish: `Publish files as a new site. It's private unless you pass rules: only you can open it, after signing in. Send files inline up to ${inline} in total; for larger sites, or files you can read from disk (such as images), use begin_upload instead. ${markdown} The result lists any problems the render found, such as links to missing pages. ${sizes} A Markdown file and the page made from it count as one file.`,
    update: `Change a site; everything not changed stays, and the URL stays the same. Send only the files that changed, list any to remove, or use edits for small changes to text files. On a Markdown site, change the .md sources: rendered pages are made again from them, and can't be edited directly. `
      + 'Every update makes a new version, so make related changes in one call. Working on a local folder? Make all the changes there first, then sync once: begin_upload with site_id and each file\'s sha256, upload what it asks for, finish_upload, then update with the upload_id and sync: true. '
      + `Change the title or data details with or without files. Pass base_version to be refused if the site changed since you read it. Earlier versions are kept for rollback: ${kept} ${sizes}`,
    set_name: `Give a site a name, which becomes its address: <name>.<site domain>. Its ID address and any old name redirect there, so links keep working. `
      + `A name is 2–40 lowercase letters, digits and single hyphens. When a site's name changes or is removed, the old name is held for ${nameHoldDays} days: it keeps redirecting, and only you can claim it again. `
      + 'Names are first come, first served, so check with the person before choosing one. '
      + 'A named site\'s public pages can appear in search engines; to keep a page out, add <meta name="robots" content="noindex"> to it.',
    set_access: 'Set who can open which parts of a site, replacing its rules. Each rule is / or a folder ending in /, and its access: [public] (anyone with the link, without signing in), a list of tiers such as [gold, silver] (members of any of them, after signing in), or private (only you, and anyone you share it with; use it to close a path inside a more open folder). '
      + 'The longest matching rule decides, and anything no rule covers is private, so rules: [] makes the whole site private. You always open everything. '
      + 'Before making anything public, check with the person: confirm_public must be true for any change that makes something public. Tiers and private need no confirmation. '
      + 'Changes take effect within seconds, and everywhere within about a minute. '
      + 'On a Markdown site, the pages are rendered again with the new rules in the same change, so lists, tags and the feed never name a page the rules make private. '
      + 'Public pages of a named site can appear in search engines; unnamed sites are never indexed.',
    share: `Share part of a site with someone by email, such as one client's proposal: they can then open path (default /, the whole site) after signing in with that email by magic link, and nothing else that isn't public. `
      + 'The share opens the path whatever its rule says, and everything under it that has no rule of its own, so sharing /proposals/acme/ with one person and /proposals/globex/ with another keeps each from the other. Folders or pages under the path with rules of their own aren\'t included (left_out lists them; tell the person, and share them separately if wanted). A public path stays public. '
      + 'They get an invite with your email and the address, never the site\'s title; sharing the same path with the same email again resends it, at most once an hour. '
      + `Before sharing, read the email back to the person: confirm_share must be true. A site can be shared with ${limits.sharesPerSite} emails, and ${rateLimits.invitesPerDay} invites can be sent a day. `
      + 'A share ends 90 days after it begins unless given expires_at (at most a year ahead); starts_at delays it. Sharing again renews it.',
    unshare: 'Stop sharing a path of a site with an email, or with no path, everything shared with them. Their next request is refused, while everyone else keeps their access. The rules don\'t change.',
    list_access: 'List who can open a site: its rules, the tiers they name, its public and members\' URLs, and its shares: each email and path, when it was shared, begins and ends, when the invite was sent and when it was last used. list_members lists the members.',
    add_member: 'Add someone to a tier of a site by email, such as gold: they can then open every path whose rule lists that tier, after signing in with that email by magic link. '
      + 'A tier needs no setting up: rules name tiers (set_access, or access in a Markdown site\'s _site.yml), and memberships put people in them. Tiers are separate: gold doesn\'t include silver, so a rule lists every tier it opens to. '
      + 'starts_at and expires_at limit when it works; without an end it lasts until removed. Adding again replaces the dates. '
      + 'They get an invite with your email and the address, never the site\'s title or the tier; at most one an hour per email and tier, counting against the daily invite limit. '
      + 'Before adding, read the email back to the person: confirm_member must be true.',
    remove_member: 'Remove someone from one tier of a site, or with no tier, from every tier. Their next request is refused; everyone else keeps their access.',
    list_members: 'List a site\'s members, a page at a time: each email, tier, when they were added, begin and end, and when they last used it. If next_cursor is returned, pass it as cursor for the next page.',
    list_shares: 'List every share across your sites, soonest end first: site, path, email, when it was shared, begins and ends, and when it was last used, so forgotten or unused shares are easy to find and remove with unshare. '
      + 'ending_within_days narrows it to shares ending soon. If next_cursor is returned, pass it as cursor for the next page.',
    get_site: `Get a site's details, its versions newest first, and the files of one version with their sizes and SHA-256 hashes, but not their contents. On a Markdown site, sources have role source, and pages made from them have role rendered and rendered_from; _passa/access.yml is a read-only copy of the rules, for folders taken out of Passa. Use get_files to read files. If next_cursor is returned, pass it as cursor for older versions. ${kept}`,
    find_sites: 'List your sites newest first, optionally matching a title or name. If next_cursor is returned, pass it as cursor for the next page.',
    get_files: `Get the contents of a site's files. Text files come back as text, up to ${inline} in total; binary files, and text past that, come back as download links valid for ${minutes}. To change a few words, use update with edits instead of resending the file.`,
    rollback: `Make an earlier version of a site current again. Takes effect immediately. On a Markdown site, the version's sources are rendered again with the site's current rules and name, as a new version. Only versions get_site lists can be restored: ${kept}`,
    delete: `Delete a site. It stops being served at once, and is removed permanently after ${deleteGraceDays} days, or immediately with now=true.`,
    begin_upload: `Start an upload, for sites over ${inline} or files you can read from disk. Returns a URL per file, valid for ${minutes}: PUT each file's bytes to its URL (for example, curl -T path/to/file '<url>'), then call finish_upload. File contents never pass through the conversation. To sync a local folder to an existing site, pass site_id and each file's sha256: only new and changed files get URLs, and update with sync: true applies the folder as a whole. ${sizes}`,
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
      sync: i.sync,
      details: {
        ...(i.title ? { title: i.title } : {}),
        ...(i.data_source !== undefined ? { dataSource: i.data_source } : {}),
        ...(i.data_as_of !== undefined ? { dataAsOf: i.data_as_of } : {}),
      },
    });
    return { result: r, siteId: r.site_id, ...accessDetail(r) };
  });

  tool('set_name', describe.set_name, { destructiveHint: true, idempotentHint: true, openWorldHint: true }, schemas.set_name, async (i) => {
    const r = await publisher.setName(caller, { siteId: i.site_id, name: i.name });
    const { from, to } = r.name_change;
    return { result: r, siteId: r.site_id, detail: `name: ${from ?? 'none'} → ${to ?? 'none'}` };
  });

  tool('set_access', describe.set_access, { destructiveHint: true, idempotentHint: true, openWorldHint: true }, schemas.set_access, async (i) => {
    const r = await publisher.setAccess(caller, { siteId: i.site_id, rules: i.rules, confirmPublic: i.confirm_public });
    return { result: r, siteId: r.site_id, ...accessDetail(r) };
  });

  tool('share', describe.share, { openWorldHint: true }, schemas.share, async (i) => {
    const r = await publisher.share(caller, {
      siteId: i.site_id, email: i.email, path: i.path, confirmShare: i.confirm_share,
      ...(i.starts_at ? { startsAt: i.starts_at } : {}), ...(i.expires_at ? { expiresAt: i.expires_at } : {}),
    });
    return { result: r, siteId: r.site_id, ...accessDetail(r, `shared ${r.share.path} with ${r.share.email}${r.invite_sent ? ', invited' : ''}`) };
  });

  tool('unshare', describe.unshare, { destructiveHint: true, idempotentHint: true }, schemas.unshare, async (i) => {
    const r = await publisher.unshare(caller, { siteId: i.site_id, email: i.email, ...(i.path ? { path: i.path } : {}) });
    return { result: r, siteId: r.site_id, detail: `unshared ${r.path ?? 'everything'} with ${r.email}` };
  });

  tool('list_access', describe.list_access, { readOnlyHint: true }, schemas.list_access, async (i) => ({
    result: await publisher.listAccess(caller, { siteId: i.site_id }),
  }));

  tool('add_member', describe.add_member, { openWorldHint: true }, schemas.add_member, async (i) => {
    const r = await publisher.addMember(caller, {
      siteId: i.site_id, email: i.email, tier: i.tier, confirmMember: i.confirm_member,
      ...(i.starts_at ? { startsAt: i.starts_at } : {}), ...(i.expires_at ? { expiresAt: i.expires_at } : {}),
    });
    return { result: r, siteId: r.site_id, detail: `added ${r.member.email} to ${r.member.tier}${r.invite_sent ? ', invited' : ''}` };
  });

  tool('remove_member', describe.remove_member, { destructiveHint: true, idempotentHint: true }, schemas.remove_member, async (i) => {
    const r = await publisher.removeMember(caller, { siteId: i.site_id, email: i.email, ...(i.tier ? { tier: i.tier } : {}) });
    return { result: r, siteId: r.site_id, detail: `removed ${r.email} from ${r.tier ?? 'every tier'}` };
  });

  tool('list_members', describe.list_members, { readOnlyHint: true }, schemas.list_members, async (i) => ({
    result: await publisher.listMembers(caller, { siteId: i.site_id, limit: i.limit, ...(i.tier ? { tier: i.tier } : {}), ...(i.cursor ? { cursor: i.cursor } : {}) }),
  }));

  tool('list_shares', describe.list_shares, { readOnlyHint: true }, schemas.list_shares, async (i) => ({
    result: await publisher.listShares(caller, {
      limit: i.limit, ...(i.site_id ? { siteId: i.site_id } : {}), ...(i.ending_within_days ? { endingWithinDays: i.ending_within_days } : {}), ...(i.cursor ? { cursor: i.cursor } : {}),
    }),
  }));

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

  tool('rollback', describe.rollback, { idempotentHint: true }, schemas.rollback, async (i) => {
    const r = await publisher.rollback(caller, { siteId: i.site_id, versionId: i.version_id, confirmPublic: i.confirm_public });
    return { result: r, siteId: r.site_id };
  });

  tool('delete', describe.delete, { destructiveHint: true }, schemas.delete, async (i) => {
    const r = await publisher.delete(caller, { siteId: i.site_id, now: i.now });
    return { result: r, siteId: r.site_id };
  });

  tool('begin_upload', describe.begin_upload, {}, schemas.begin_upload, async (i) => ({
    result: await publisher.beginUpload(caller, {
      files: i.files.map((f) => ({ path: f.path, size: f.size, ...(f.sha256 ? { sha256: f.sha256 } : {}) })),
      ...(i.site_id ? { siteId: i.site_id } : {}),
    }),
    ...(i.site_id ? { siteId: i.site_id } : {}),
  }));

  tool('finish_upload', 'Confirm an upload is complete. Then pass its upload_id to publish or update.', { idempotentHint: true }, schemas.finish_upload, async (i) => ({
    result: await publisher.finishUpload(caller, { uploadId: i.upload_id }),
  }));

  tool('theme_guide', 'How Markdown sites render, and how to theme them: front matter, the Markdown extensions, the built-in widgets and their HTML, the values layouts receive (the theme contract), the rules a theme must follow, and the default theme\'s layouts and CSS to start from. Read it before writing _layouts/ or widgets.',
    { readOnlyHint: true }, schemas.theme_guide, () => Promise.resolve({ result: THEME_GUIDE }));

  return server;
}
