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
  type Grant,
  isSiteId,
  isUploadId,
  isVersionId,
  type MailProvider,
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
  storedPath,
  syncEdge,
  THREATS,
  accessFor,
  isPublicAccess,
  TooManyShares,
  BadCursor,
  grantIsLive,
  isTierName,
  type Membership,
  tiersOf,
  type UploadSync,
  type Version,
} from '@passa/shared';
import { type Card, CARD_HEIGHT, CARD_WIDTH, cardFont, DEFAULT_CARD_FONTS, drawCard, isSource, REFUSING, render, RULES_FILE, rulesFile } from '@passa/render';
import { cardHash, type CheckedFile, checkContent, checkManifest, type InputFile, PublishRefused } from './checks.ts';
import { inviteEmail } from './invite.ts';

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
  // A site's URL at its custom domain; https://<domain>/ unless set (local).
  domainUrl?: (domain: string) => string;
  // Uploads are scanned by GuardDuty Malware Protection (in AWS, not locally),
  // and publish checks each file's result first.
  malwareScan?: boolean;
  // How long a publish spends drawing social cards (default 4 s), and how the
  // rest are drawn just after it (in AWS, the cards function). Without it,
  // they're drawn by the next change to the site.
  cardBudgetMs?: number;
  drawCardsLater?: (siteId: string, versionId: string) => Promise<void>;
  // Sends sharing invites (M5 R130), in the background in AWS (R145).
  mailer?: MailProvider;
};

// The social cards a version's pages name, and the fonts they're drawn with
// (theme font paths, or none for the default card's).
type CardJob = { cards: Card[]; fonts: string[] };
// What happened to cards sent with a site.
type SentCards = { stored: number; skipped: string[] };
const sentCardsResult = (s: SentCards) => ({ ...(s.stored ? { cards_stored: s.stored } : {}), ...(s.skipped.length ? { cards_skipped: s.skipped } : {}) });
const NO_CARDS: CardJob = { cards: [], fonts: [] };
const CARD_BUDGET_MS = 4000;
// The cards function's own budget, inside its 5-minute limit.
export const CARDS_LATER_MS = 240_000;

// A refusal the agent should see as it is. Anything else is reported generically.
export class ToolError extends Error {}

const NOT_FOUND = 'No site with that ID.';
const HOUR_MS = 3_600_000;
const DAY_S = 86_400;
// Shares end 90 days after they begin unless given an end, and at most a year
// ahead (M6 R158). Memberships needn't end.
const SHARE_DAYS = 90;
const MAX_GRANT_MS = 366 * DAY_S * 1000;
const MEMBERS_PAGE = 100;
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
  // Its custom domains (M4 R126); the primary one is then its address.
  domain?: string;
  domains?: string[];
  access: Access;
  rules?: Rule[];
};

// What a change of rules did, for the response and the event (R48).
// narrowed: something open to more people before is open to fewer now.
export type AccessChange = { made_public: string[]; made_members: string[]; made_private: string[]; narrowed?: boolean };

// When a grant begins and ends, and when it was last used (M6 R158, R166).
type GrantDates = { starts_at?: string; expires_at?: string; invited_at?: string; last_used: string };
const datesOf = (g: Grant | Membership): GrantDates => ({
  ...(g.startsAt ? { starts_at: g.startsAt } : {}),
  ...(g.expiresAt ? { expires_at: g.expiresAt } : {}),
  ...(g.invitedAt ? { invited_at: g.invitedAt } : {}),
  last_used: g.lastUsedAt ?? 'never',
});

// A share as list_access shows it (M5 R132).
export type Share = { email: string; path: string; shared_at: string } & GrantDates;
const shareOf = (g: Grant): Share => ({ email: g.email, path: g.path, shared_at: g.createdAt, ...datesOf(g) });

// A path one email can or can't open, and why (M6 R159).
export type PathAccess = { path: string; url: string; why: string };

// A membership as list_members shows it (M6 R155).
export type Member = { email: string; tier: string; added_at: string } & GrantDates;
const memberOf = (m: Membership): Member => ({ email: m.email, tier: m.tier, added_at: m.createdAt, ...datesOf(m) });

export type SiteFile = {
  path: string; size: number; content_type: string; sha256: string; role?: FileEntry['role']; rendered_from?: string; content?: string; download_url?: string;
};

export type Content = { files: InputFile[] } | { uploadId: string };

// Replaces old with new in a text file; old must appear exactly once.
export type Edit = { path: string; old: string; new: string };

// What a new version is made from. The site's details and rules are what its
// pages render with; confirmPublic also confirms a page marked access: private
// that the rules make public (M3 R89).
// rulesGiven: rules came with the call, which a site whose files declare its
// access refuses (M6 R150).
type Changes = {
  content?: Content; edited?: InputFile[]; base?: Version; remove?: string[];
  site: Pick<Site, 'id' | 'name' | 'title'>; rules: Rule[]; confirmPublic: boolean; rulesGiven?: boolean;
};
// The rules a version's files declare, and what they change from the rules before.
type FileAccess = { fileRules?: Rule[]; fileChange?: AccessChange };
const FROM_FILES = 'This site\'s access comes from its files (access in _site.yml, and pages\' front matter)';

// A file Passa rendered for a version, and whether the base version has it already.
type RenderedFile = { entry: FileEntry; content: Uint8Array; unchanged: boolean; fragment?: boolean };

const isText = (f: FileEntry) => f.contentType.includes('charset=utf-8');
const encode = (text: string) => new TextEncoder().encode(text);

// Why a rendered file can't be changed directly.
const renderedProblem = (f: FileEntry, action: string) =>
  `${f.path}: rendered ${f.from ? `from ${f.from}, so ${action} that instead` : `by Passa, so it can't be ${action === 'edit' ? 'edited' : 'removed'}`}`;

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

  // A site's one address: its primary domain (M4 R124), else its name (M2
  // R45, R47), else its ID.
  #url(site: Pick<Site, 'id' | 'name' | 'domain'>) {
    if (site.domain) return this.#d.domainUrl ? this.#d.domainUrl(site.domain) : `https://${site.domain}/`;
    const label = site.name ?? site.id;
    return this.#d.siteUrl ? this.#d.siteUrl(label) : `https://${label}.${siteDomain(this.#d.config)}/`;
  }

  #summary(site: Site): SiteSummary {
    return {
      site_id: site.id,
      url: this.#url(site),
      ...(site.name ? { name: site.name } : {}),
      ...(site.domain ? { domain: site.domain } : {}),
      ...(site.domains?.length ? { domains: site.domains } : {}),
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
  // public needs confirmPublic (R37), whichever way it happens. Private and
  // shared need no confirmation either way (M5 R138).
  #checkAccess(before: Rule[], after: Rule[], confirmPublic: boolean): AccessChange {
    const problems = checkRules(after);
    if (problems.length) throw new PublishRefused(problems);
    const { madePublic, madeMembers, madePrivate } = accessChanges(before, after);
    if (madePublic.length && !confirmPublic) {
      throw new ToolError(`This would make ${madePublic.join(', ')} public: anyone with the link could open ${madePublic.length > 1 ? 'them' : 'it'} without signing in. `
        + 'Check with the person first, then call again with confirm_public set to true.');
    }
    const narrowed = madePrivate.length > 0 || madeMembers.some((p) => isPublicAccess(accessFor(before, `${p}index.html`)));
    return { made_public: madePublic, made_members: madeMembers, made_private: madePrivate, narrowed };
  }

  // The public and shared URLs, and a reminder when access was narrowed, since
  // the edge can take up to a minute everywhere (R40).
  #accessResult(site: Site, change: AccessChange) {
    const { public: open, members } = regions(site.rules ?? []);
    const { narrowed, ...made } = change;
    return {
      ...made,
      public_urls: open.map((p) => this.#url(site) + p.slice(1)),
      ...(members.length ? { member_urls: members.map((p) => this.#url(site) + p.slice(1)) } : {}),
      ...(narrowed ? { note: 'Paths made private or for members can stay open as before at some edge locations for up to a minute.' } : {}),
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
  // the base version's other files (copied within S3) unless removed, plus the
  // pages rendered from its sources (M3 R70), copied when they haven't changed.
  async #storeVersion(caller: Caller, siteId: string, changes: Changes): Promise<{ version: Version; skipped: string[]; written: number; problems: string[]; cards: CardJob; sentCards: SentCards } & FileAccess> {
    const { content, edited = [], base, remove = [] } = changes;
    const received = !content
      ? { files: [], skipped: [] }
      : 'files' in content ? this.#checkInline(content.files) : await this.#takeUpload(caller, content.uploadId, siteId);
    // Cards sent with the site go to its cards, not the version.
    const sentCardFiles = received.files.filter((f) => cardHash(f.path));
    const sent = { ...received, files: received.files.filter((f) => !cardHash(f.path)) };
    const editedPaths = new Set(edited.map((f) => f.path.toLowerCase()));
    const overlap = sent.files.filter((f) => editedPaths.has(f.path.toLowerCase())).map((f) => `${f.path}: both sent and edited`);
    if (overlap.length) throw new PublishRefused(overlap);
    const { skipped } = sent;
    const checked = await checkContent([...sent.files, ...edited]);
    const replaced = new Set([...checked, ...remove.map((path) => ({ path }))].map((f) => f.path.toLowerCase()));
    // Rendered files are made again from the sources every time (M3 R71). A
    // file's role follows its path, so a site's Markdown from before M3 becomes
    // a source when it's next updated.
    const withRole = (f: FileEntry): FileEntry =>
      ({ path: f.path, size: f.size, contentType: f.contentType, sha256: f.sha256, ...(isSource(f.path) ? { role: 'source' as const } : {}) });
    const kept = (base?.files ?? []).filter((f) => f.role !== 'rendered' && !replaced.has(f.path.toLowerCase()));
    const authored = [...kept.map(withRole), ...checked.map((f) => withRole({ path: f.path, size: f.size, contentType: f.contentType, sha256: f.sha256 }))];
    const fresh = new Map(checked.map((f) => [f.path, f.content]));
    const { rendered, problems, cards, ...fileAccess } = await this.#render(changes, authored, fresh, kept);
    const sentCards = await this.#storeSentCards(siteId, sentCardFiles, cards);
    const entries = [...authored, ...rendered.map((r) => r.entry)].sort((a, b) => a.path.localeCompare(b.path));
    this.#checkTotals(entries);

    const version: Version = {
      id: newVersionId(this.#now().getTime()),
      siteId,
      files: entries,
      size: entries.reduce((sum, f) => sum + f.size, 0),
      createdAt: this.#now().toISOString(),
      createdBy: caller.userId,
    };
    // New content, including changed rendered pages, is staged and scanned.
    const written = [...checked.map((f: CheckedFile) => ({ entry: withRole(f), content: f.content })), ...rendered.filter((r) => !r.unchanged)];
    await inBatches(written, (file) => this.#d.files.putVersionFile(siteId, version.id, storedPath(file.entry), file.content, file.entry.contentType, { fragment: 'fragment' in file && file.fragment === true }));
    if (base) {
      const copies = [...kept.map((f) => ({ from: f, to: withRole(f) })), ...rendered.filter((r) => r.unchanged).map((r) => ({ from: r.entry, to: r.entry }))];
      await inBatches(copies, ({ from, to }) => this.#d.files.copyVersionFile(siteId, base.id, version.id, storedPath(from), storedPath(to)), COPY_PARALLEL);
    }
    if (content && 'uploadId' in content) await this.#d.files.deleteUpload(content.uploadId);
    return { version, skipped, written: written.length, problems, cards, sentCards, ...fileAccess };
  }

  // Renders the version's sources, if it has any: its pages, its feed, and the
  // read-only copy of its rules (M3 R88). Refused on a page that would replace a
  // file (R68), a missing layout (R79), or an unconfirmed page marked private
  // that the rules make public (R89); other problems are returned (R90).
  async #render(changes: Changes, authored: FileEntry[], fresh: Map<string, Uint8Array>, kept: FileEntry[]): Promise<{ rendered: RenderedFile[]; problems: string[]; cards: CardJob } & FileAccess> {
    const sourceEntries = authored.filter((f) => f.role === 'source');
    if (!sourceEntries.length) return { rendered: [], problems: [], cards: NO_CARDS };
    const { base, site, rules, confirmPublic } = changes;
    const keptByPath = new Map(kept.map((f) => [f.path, f]));
    const sources = await Promise.all(sourceEntries.map(async (f) => {
      let bytes = fresh.get(f.path);
      const before = keptByPath.get(f.path);
      if (!bytes && base && before) bytes = await this.#d.files.getVersionFile(site.id, base.id, storedPath(before));
      return { path: f.path, content: Buffer.from(bytes ?? new Uint8Array()).toString('utf8') };
    }));
    const result = this.#renderSources(site, rules, authored, sources);
    const refusing = result.problems.filter((p) => REFUSING.has(p.kind) && !(p.kind === 'access-private-made-public' && confirmPublic));
    if (refusing.length) {
      throw new PublishRefused(refusing.map((p) => p.kind === 'access-private-made-public'
        ? `${p.message}: change its front matter, or check with the person and call again with confirm_public set to true`
        : p.message));
    }
    // A site whose files declare its access (M6 R150): those rules are its
    // rules, checked like any, with confirm_public for anything made public.
    const fileRules = result.rules;
    if (fileRules && changes.rulesGiven) throw new ToolError(`${FROM_FILES}, so rules can't be passed as well. Change _site.yml instead.`);
    const fileChange = fileRules ? this.#checkAccess(rules, fileRules, confirmPublic) : undefined;
    const outputs = [
      ...result.pages.map((p) => ({ path: p.path, content: encode(p.html), from: p.from, fragment: p.fragment === true })),
      ...(result.feed ? [{ path: 'feed.xml', content: encode(result.feed), from: null }] : []),
      { path: RULES_FILE, content: encode(rulesFile(fileRules ?? rules)), from: null },
    ];
    const fromOf = new Map(outputs.map((o) => [o.path, o.from]));
    const fragments = new Set(outputs.filter((o) => 'fragment' in o && o.fragment).map((o) => o.path));
    // Rendered pages pass the same checks as any file.
    const checked = await checkContent(outputs.map(({ path, content }) => ({ path, content })));
    const before = new Map((base?.files ?? []).filter((f) => f.role === 'rendered').map((f) => [f.path, f]));
    return {
      rendered: checked.map((f) => {
        const from = fromOf.get(f.path);
        const entry: FileEntry = { path: f.path, size: f.size, contentType: f.contentType, sha256: f.sha256, role: 'rendered', ...(from ? { from } : {}) };
        return { entry, content: f.content, unchanged: before.get(f.path)?.sha256 === f.sha256, ...(fragments.has(f.path) ? { fragment: true } : {}) };
      }),
      problems: result.problems.filter((p) => !REFUSING.has(p.kind)).map((p) => p.message),
      cards: { cards: result.cards ?? [], fonts: result.cardFonts ?? [] },
      ...(fileRules && fileChange ? { fileRules, fileChange } : {}),
    };
  }

  #renderSources(site: Pick<Site, 'id' | 'name' | 'title'>, rules: Rule[], entries: FileEntry[], sources: { path: string; content: string }[]) {
    const plain = entries.filter((f) => f.role !== 'source');
    const hashes = new Map(plain.map((f) => [f.path, f.sha256]));
    return render({ sources, rules, siteUrl: this.#url(site), siteTitle: site.title, files: plain.map((f) => f.path), cards: { fileHash: (path) => hashes.get(path) } });
  }

  // Cards drawn outside Passa (passa render), sent at the paths Passa serves
  // them: stored if a page in this version names them and the site doesn't
  // have them yet, so Passa needn't draw them. Passa can't tell what a card
  // shows from its pixels, so, like socialImage, it's the owner's choice.
  async #storeSentCards(siteId: string, files: InputFile[], job: CardJob): Promise<SentCards> {
    if (!files.length) return { stored: 0, skipped: [] };
    const checked = await checkContent(files);
    const wrongSize = checked.filter((f) => f.content.byteLength < 24 || Buffer.from(f.content).readUInt32BE(16) !== CARD_WIDTH || Buffer.from(f.content).readUInt32BE(20) !== CARD_HEIGHT);
    if (wrongSize.length) throw new PublishRefused(wrongSize.map((f) => `${f.path}: a card must be a ${CARD_WIDTH}×${CARD_HEIGHT} PNG`));
    const named = new Set(job.cards.map((c) => c.hash));
    const have = await this.#d.files.listCards(siteId);
    const skipped: string[] = [];
    const store: CheckedFile[] = [];
    for (const f of checked) {
      const hash = cardHash(f.path) ?? '';
      if (!named.has(hash)) skipped.push(`${f.path}: no public page in this version names this card`);
      else if (!have.has(hash) && !store.some((s) => cardHash(s.path) === hash)) store.push(f);
    }
    await inBatches(store, (f) => this.#d.files.putCard(siteId, cardHash(f.path) ?? '', f.content, { staged: true }));
    return { stored: store.length, skipped };
  }

  // Draws the cards a version names that the site doesn't have yet, for up to
  // budget ms (M3 R95–R97). Cards are named by the hash of what draws them, so
  // one that exists is never drawn again, whichever version named it.
  async #drawCards(siteId: string, version: Version, job: CardJob, budget: number): Promise<{ drawn: number; waiting: number; failed: string[] }> {
    const deadline = Date.now() + budget;
    const unique = [...new Map(job.cards.map((c) => [c.hash, c])).values()];
    if (!unique.length) return { drawn: 0, waiting: 0, failed: [] };
    const have = await this.#d.files.listCards(siteId);
    const missing = unique.filter((c) => !have.has(c.hash));
    if (!missing.length) return { drawn: 0, waiting: 0, failed: [] };
    const read = (path: string) => this.#d.files.getVersionFile(siteId, version.id, path);
    const fonts = job.fonts.length
      ? (await Promise.all(job.fonts.map(async (path) => cardFont(path, await read(path))))).filter((f) => f !== undefined)
      : DEFAULT_CARD_FONTS;
    const images = new Map<string, Uint8Array>();
    let drawn = 0;
    const failed: string[] = [];
    for (const card of missing) {
      if (Date.now() >= deadline) break;
      try {
        for (const path of card.images) if (!images.has(path)) images.set(path, await read(path));
        await this.#d.files.putCard(siteId, card.hash, await drawCard(card.html, { fonts, image: (path) => images.get(path) }));
        drawn++;
      } catch (err) {
        failed.push(`${card.path}: the card couldn't be drawn (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      }
    }
    return { drawn, waiting: missing.length - drawn - failed.length, failed };
  }

  // After a version is current: draws its cards within the publish's budget,
  // and hands the rest to drawCardsLater. Returns what the result reports.
  async #finishCards(siteId: string, version: Version, job: CardJob) {
    const { waiting, failed } = await this.#drawCards(siteId, version, job, this.#d.cardBudgetMs ?? CARD_BUDGET_MS);
    if (waiting && this.#d.drawCardsLater) await this.#d.drawCardsLater(siteId, version.id);
    return {
      ...(waiting ? { cards_waiting: waiting, cards_note: this.#d.drawCardsLater ? 'The remaining social cards are being drawn now, and appear within a few minutes.' : 'The remaining social cards are drawn by the next change to the site.' } : {}),
      ...(failed.length ? { card_problems: failed } : {}),
    };
  }

  // The cards function: draws what a publish had no time for, if the version
  // is still current (a newer one draws its own).
  async drawPendingCards(siteId: string, versionId: string): Promise<{ drawn: number; waiting: number; failed: string[] }> {
    const site = await this.#d.store.getSite(siteId);
    if (!site || site.status !== 'active' || site.current !== versionId) return { drawn: 0, waiting: 0, failed: [] };
    const version = await this.#version(site, versionId);
    const authored = version.files.filter((f) => f.role !== 'rendered');
    const sources = await Promise.all(authored.filter((f) => f.role === 'source').map(async (f) => ({
      path: f.path, content: Buffer.from(await this.#d.files.getVersionFile(site.id, version.id, storedPath(f))).toString('utf8'),
    })));
    if (!sources.length) return { drawn: 0, waiting: 0, failed: [] };
    const result = this.#renderSources(site, site.rules ?? [], authored, sources);
    return this.#drawCards(site.id, version, { cards: result.cards ?? [], fonts: result.cardFonts ?? [] }, CARDS_LATER_MS);
  }

  // On a site with sources, anything that changes what its pages say (its
  // rules, its name, which version is current) makes a new version, rendered
  // from the base version's sources (M3 R71, R84, R85). The version and any new
  // rules are written in one change, so no page ever lists what the rules hide.
  // Returns undefined for a site without sources, which needs no new version.
  async #rerender(caller: Caller, site: Site, base: Version, change: { rules: Rule[]; confirmPublic: boolean; setRules?: boolean }) {
    if (!base.files.some((f) => f.role === 'source')) return undefined;
    const { version, problems, cards, fileRules } = await this.#storeVersion(caller, site.id, { base, site, rules: change.rules, confirmPublic: change.confirmPublic });
    const rules = fileRules ? { rules: fileRules, seen: site.updatedAt, fromFiles: true }
      : change.setRules || site.accessFromFiles ? { rules: change.rules, seen: site.updatedAt } : undefined;
    try {
      await this.#d.store.addVersion(caller.userId, version, site.current, rules);
    } catch (err) {
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const now = await this.#d.store.getSite(site.id);
      throw new ToolError(now?.ownerId === caller.userId && now.status === 'active' ? 'The site changed while this was running. Get the site again and retry.' : NOT_FOUND);
    }
    return { version_id: version.id, ...(problems.length ? { problems } : {}), ...(await this.#finishCards(site.id, version, cards)) };
  }

  // Limits on the whole version, after changes are applied to the base.
  #checkTotals(entries: FileEntry[]) {
    const { limits } = this.#d.config;
    const problems: string[] = [];
    if (entries.length === 0) problems.push('no files left in the site');
    // A source and the page rendered from it count as one file (M3 R70).
    if (entries.filter((f) => f.role !== 'rendered').length > limits.files) problems.push(`more than ${limits.files} files`);
    if (entries.reduce((sum, f) => sum + f.size, 0) > limits.site) problems.push(`larger than the ${limits.site}-byte total limit`);
    if (problems.length) throw new PublishRefused(problems);
  }

  #checkInline(files: InputFile[]) {
    const { limits } = this.#d.config;
    const { keep, skipped } = checkManifest(files.map((f) => ({ path: f.path, size: f.content.byteLength })), limits, limits.inlinePublish);
    return { files: files.filter((f) => keep.has(f.path)), skipped };
  }

  async #getUpload(caller: Caller, uploadId: string) {
    const upload = isUploadId(uploadId) ? await this.#d.store.getUpload(uploadId, this.#now().toISOString()) : undefined;
    if (!upload || upload.ownerId !== caller.userId || upload.status === 'used') throw new ToolError('No upload with that ID.');
    return upload;
  }

  // A sync upload only holds the folder's new and changed files, so it can only
  // be used on the site it was compared with.
  async #takeUpload(caller: Caller, uploadId: string, siteId: string) {
    const upload = await this.#getUpload(caller, uploadId);
    if (upload.sync && upload.sync.siteId !== siteId) throw new ToolError(`This upload syncs site ${upload.sync.siteId}: use it with update and sync: true.`);
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
    const { version, skipped, problems, cards, sentCards, fileRules, fileChange } = await this.#storeVersion(caller, siteId, {
      content: input.content, site: { id: siteId, title: input.title }, rules: input.rules ?? [], confirmPublic: input.confirmPublic ?? false, rulesGiven: !!input.rules?.length,
    });
    const rules = fileRules ?? input.rules;
    const site: Site = {
      id: siteId,
      ownerId: caller.userId,
      title: input.title,
      ...(input.dataSource ? { dataSource: input.dataSource } : {}),
      ...(input.dataAsOf ? { dataAsOf: input.dataAsOf } : {}),
      ...(rules?.length ? { rules } : {}),
      ...(fileRules ? { accessFromFiles: true } : {}),
      current: version.id,
      accessVersion: 1,
      status: 'active',
      createdAt: version.createdAt,
      updatedAt: version.createdAt,
    };
    await this.#d.store.createSite(site, version);
    await this.#sync(site.id);
    const drawn = await this.#finishCards(site.id, version, cards);
    return { ...this.#summary(site), files: version.files.length, skipped, ...(problems.length ? { problems } : {}), ...sentCardsResult(sentCards), ...drawn, ...(fileChange ?? change ? this.#accessResult(site, (fileChange ?? change) as AccessChange) : {}) };
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
    // With an upload from begin_upload with this site: make the site exactly
    // that folder, removing the files that aren't in it.
    sync?: boolean;
  }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    if (input.baseVersion && input.baseVersion !== site.current) {
      throw new ToolError(`The site has changed since version ${input.baseVersion}: its current version is ${site.current}. Get the site again and retry.`);
    }
    if (input.sync) input = { ...input, remove: await this.#syncRemovals(caller, site, input.content) };
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
      const current = new Map(base.files.map((f) => [f.path, f]));
      const sent = new Set(input.content && 'files' in input.content ? input.content.files.map((f) => f.path) : []);
      const edited = new Set(edits.map((e) => e.path));
      const problems = [
        ...remove.filter((p) => !current.has(p)).map((p) => `${p}: not in the current version, so it can't be removed`),
        ...remove.flatMap((p) => { const f = current.get(p); return f?.role === 'rendered' ? [renderedProblem(f, 'remove')] : []; }),
        ...remove.filter((p) => sent.has(p)).map((p) => `${p}: both sent and removed`),
        ...remove.filter((p) => edited.has(p)).map((p) => `${p}: both edited and removed`),
      ];
      if (problems.length) throw new PublishRefused(problems);
    }
    const edited = base && edits.length ? await this.#applyEdits(base, edits) : [];
    const { version, skipped, written, problems, cards, sentCards, fileRules, fileChange } = await this.#storeVersion(caller, site.id, {
      ...(input.content ? { content: input.content } : {}),
      ...(base ? { base } : {}),
      edited,
      remove,
      site: { ...site, ...(input.details?.title ? { title: input.details.title } : {}) },
      rules: input.rules ?? site.rules ?? [],
      confirmPublic: input.confirmPublic ?? false,
      rulesGiven: !!input.rules,
    });
    // The files' rules when they declare access; the rules sent; or, when the
    // files have stopped declaring access, the rules as they were, kept.
    const rules = fileRules ? { rules: fileRules, seen: site.updatedAt, fromFiles: true }
      : input.rules ? { rules: input.rules, seen: site.updatedAt }
      : site.accessFromFiles ? { rules: site.rules ?? [], seen: site.updatedAt } : undefined;
    try {
      // Fails if another update landed first, so neither silently undoes the other.
      await this.#d.store.addVersion(caller.userId, version, site.current, rules);
    } catch (err) {
      if (!(err instanceof NotFoundOrConflict)) throw err;
      const now = await this.#d.store.getSite(site.id);
      throw new ToolError(now?.ownerId === caller.userId && now.status === 'active'
        ? 'The site changed while this update was running. Get the site again and retry.'
        : NOT_FOUND);
    }
    if (input.details) await this.#setDetails(caller, site, input.details);
    const updated = (await this.#sync(site.id)) ?? site;
    const drawn = await this.#finishCards(site.id, version, cards);
    return {
      ...this.#summary(updated),
      files: version.files.length,
      // Files written new, including pages rendered differently; the rest were copied.
      changed: written,
      removed: remove.length,
      skipped,
      ...(problems.length ? { problems } : {}),
      ...sentCardsResult(sentCards),
      ...drawn,
      ...(fileChange ?? change ? this.#accessResult(updated, (fileChange ?? change) as AccessChange) : {}),
    };
  }

  // What a sync removes: the files the folder didn't have, as begin_upload
  // found them. Refused if the site has moved on since, since the comparison
  // was against the version current then.
  async #syncRemovals(caller: Caller, site: Site, content: Content | undefined): Promise<string[]> {
    if (!content || !('uploadId' in content)) throw new ToolError('sync needs an upload_id from begin_upload with this site_id.');
    const { sync } = await this.#getUpload(caller, content.uploadId);
    if (sync?.siteId !== site.id) throw new ToolError('This upload wasn\'t started for this site. Call begin_upload with site_id to sync a folder.');
    if (sync.baseVersion !== site.current) {
      throw new ToolError(`The site has changed since begin_upload: its current version is ${site.current}. Call begin_upload again.`);
    }
    return sync.remove;
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
      if (entry.role === 'rendered') return void problems.push(renderedProblem(entry, 'edit'));
      if (!isText(entry)) return void problems.push(`${path}: only text files can be edited; send the whole file instead`);
      let text = Buffer.from(await this.#d.files.getVersionFile(base.siteId, base.id, storedPath(entry))).toString('utf8');
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
          ? { content: Buffer.from(await this.#d.files.getVersionFile(version.siteId, version.id, storedPath(f))).toString('utf8') }
          : { download_url: await this.#d.files.presignVersionFile(version.siteId, version.id, storedPath(f), config.lifetimes.uploadUrl) }),
      }))),
    };
  }

  async #version(site: Site, versionId = site.current): Promise<Version> {
    const version = isVersionId(versionId) ? await this.#d.store.getVersion(site.id, versionId) : undefined;
    if (!version) throw new ToolError('No version with that ID.');
    return version;
  }

  #fileDetails(f: FileEntry): SiteFile {
    return { path: f.path, size: f.size, content_type: f.contentType, sha256: f.sha256, ...(f.role ? { role: f.role } : {}), ...(f.from ? { rendered_from: f.from } : {}) };
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

  // A Markdown site's earlier version is rendered again with the site's rules
  // and name as they are now, as a new version: its pages may list what the
  // rules have hidden since. Unchanged pages are copied, as on any update.
  async rollback(caller: Caller, input: { siteId: string; versionId: string; confirmPublic?: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const target = isVersionId(input.versionId) ? await this.#d.store.getVersion(site.id, input.versionId) : undefined;
    if (!target) throw new ToolError('No version with that ID.');
    const rendered = await this.#rerender(caller, site, target, { rules: site.rules ?? [], confirmPublic: input.confirmPublic ?? false });
    if (rendered) return { ...this.#summary((await this.#sync(site.id)) ?? site), restored_from: target.id, ...rendered };
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
    if (site.accessFromFiles) throw new ToolError(`${FROM_FILES}. Change access there and update the site, rather than set_access.`);
    const change = this.#checkAccess(site.rules ?? [], input.rules, input.confirmPublic);
    const rendered = await this.#saveRules(caller, site, input.rules, input.confirmPublic);
    const updated = (await this.#sync(site.id)) ?? site;
    return { ...this.#summary(updated), ...this.#accessResult(updated, change), ...(rendered ?? {}) };
  }

  // Stores new rules, already checked. A Markdown site gets a new version with
  // them, in the same change (M3 R85); its render result is returned.
  async #saveRules(caller: Caller, site: Site, rules: Rule[], confirmPublic: boolean) {
    const rendered = await this.#rerender(caller, site, await this.#version(site), { rules, confirmPublic, setRules: true });
    if (!rendered) {
      try {
        await this.#d.store.setRules(caller.userId, site.id, rules, this.#now().toISOString(), site.updatedAt);
      } catch (err) {
        if (!(err instanceof NotFoundOrConflict)) throw err;
        const now = await this.#d.store.getSite(site.id);
        throw new ToolError(now?.ownerId === caller.userId && now.status === 'active' ? 'The site changed while this was running. Get the site again and retry.' : NOT_FOUND);
      }
    }
    return rendered;
  }

  // Shares a path of a site with an email (M5 R128–R134, M6 R156): the email
  // may open the rule at that path, whatever its audiences, and every folder
  // and page under it without a rule of its own. A path with no rule gets one
  // copying the access above it, so nobody else's access changes. An invite
  // goes to the email, at most hourly per path.
  async share(caller: Caller, input: { siteId: string; email: string; path: string; startsAt?: string; expiresAt?: string; confirmShare: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const email = input.email.trim().toLowerCase();
    const owner = await this.#d.store.getUser(caller.userId);
    if (email === owner?.email) throw new ToolError('That\'s your own email: you can open every part of the site already.');
    if (email.includes('#')) throw new ToolError('Passa can\'t share with an email that has # in it.');
    if (!input.confirmShare) {
      throw new ToolError(`This would let ${email} open ${input.path} after signing in, and email them an invite. Read the address back to the person exactly as written here, `
        + 'since a typo shares private pages with a stranger, then call again with confirm_share set to true.');
    }
    const now = this.#now();
    const dates = this.#grantDates(input, true);
    const { mailer, config, store } = this.#d;
    if (!mailer) throw new ToolError('This deployment can\'t send email, so it can\'t send the invite.');

    // The rules first: the share needs a rule at its path to open. One copying
    // the access above it changes nobody's access; a public path needs none.
    const before = site.rules ?? [];
    const above = accessFor(before, `${input.path}index.html`);
    const isPublic = isPublicAccess(above);
    const rules = isPublic || before.some((r) => r.path === input.path) ? before : [...before, { path: input.path, access: above }];
    if (rules !== before && site.accessFromFiles) {
      throw new ToolError(`${FROM_FILES}, and ${input.path} has no rule of its own for the share to open. Add one there with the access it has now (${above === 'private' ? 'private' : `[${above.join(', ')}]`}), update the site, then share.`);
    }
    const change = this.#checkAccess(before, rules, false);

    const existing = await store.getGrant(site.id, email, input.path);
    const resend = await this.#mayInvite(caller, existing);
    const grant: Grant = {
      siteId: site.id, email, path: input.path, tier: 'shared', source: 'share',
      createdAt: existing?.createdAt ?? now.toISOString(),
      ...dates,
      ...(resend ? { invitedAt: now.toISOString() } : existing?.invitedAt ? { invitedAt: existing.invitedAt } : {}),
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    try {
      await store.putGrant(grant, site.ownerId, config.limits.sharesPerSite);
    } catch (err) {
      if (!(err instanceof TooManyShares)) throw err;
      throw new ToolError(`This site has ${config.limits.sharesPerSite} shares, the most allowed. Unshare one first.`);
    }
    // A share sharing again with a later start or an earlier end narrows it.
    if (existing) await store.bumpAccessVersion(site.id, now.toISOString());
    const rendered = rules === before ? undefined : await this.#saveRules(caller, site, rules, false);
    const updated = (await this.#sync(site.id)) ?? site;
    // Folders and pages under the path with rules of their own aren't part of
    // the share (R156): say so.
    const leftOut = (updated.rules ?? []).filter((r) => r.path !== input.path && r.path.startsWith(input.path) && !isPublicAccess(r.access)).map((r) => this.#url(updated) + r.path.slice(1));
    if (resend) await mailer.send(inviteEmail({ to: email, from: owner?.email ?? 'Someone', url: this.#url(updated) + input.path.slice(1), ...this.#inviteDates(grant) }));
    return {
      ...this.#summary(updated),
      ...this.#accessResult(updated, change),
      share: shareOf(grant),
      ...(leftOut.length ? { left_out: leftOut, share_note: `Not included: ${leftOut.join(', ')} ${leftOut.length > 1 ? 'have their own rules' : 'has its own rule'}. Share ${leftOut.length > 1 ? 'them' : 'it'} separately to include ${leftOut.length > 1 ? 'them' : 'it'}.` } : {}),
      ...(isPublic ? { share_note: `${input.path} is public, so anyone can open it already; the share matters only if it's made restricted later.` } : {}),
      invite_sent: resend,
      ...(resend ? {} : { invite_note: 'An invite for this path went to this email less than an hour ago, so another wasn\'t sent.' }),
      ...(rendered ?? {}),
    };
  }

  // A grant's start and end from the caller's (M6 R158): an end in the past,
  // or not after the start, is refused as a mistake. A share always ends: 90
  // days after it begins unless given an end, and at most a year ahead.
  #grantDates(input: { startsAt?: string; expiresAt?: string }, share: boolean): { startsAt?: string; expiresAt?: string } {
    const now = this.#now().getTime();
    const startsAt = input.startsAt ? Date.parse(input.startsAt) : undefined;
    const begins = Math.max(now, startsAt ?? now);
    let expiresAt = input.expiresAt ? Date.parse(input.expiresAt) : undefined;
    if (expiresAt !== undefined && expiresAt <= now) throw new ToolError('expires_at is in the past. Give an end ahead of now.');
    if (expiresAt !== undefined && expiresAt <= begins) throw new ToolError('expires_at must be after starts_at.');
    if (share) {
      expiresAt ??= Math.min(begins + SHARE_DAYS * DAY_S * 1000, now + MAX_GRANT_MS);
      if (expiresAt < now + HOUR_MS || expiresAt > now + MAX_GRANT_MS) throw new ToolError('A share ends at least an hour and at most a year from now.');
      if (expiresAt <= begins) throw new ToolError('A share ends at most a year from now, so starts_at must be before then.');
    }
    return {
      ...(startsAt !== undefined && startsAt > now ? { startsAt: new Date(startsAt).toISOString() } : {}),
      ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    };
  }

  // Whether a grant's invite goes again: at most hourly per grant, and within
  // the caller's daily cap (M5 R130, M6 R153).
  async #mayInvite(caller: Caller, existing: { invitedAt?: string } | undefined): Promise<boolean> {
    const now = this.#now().getTime();
    if (existing?.invitedAt && Date.parse(existing.invitedAt) > now - HOUR_MS) return false;
    const { store, config } = this.#d;
    const dayStart = Math.floor(now / 1000 / DAY_S) * DAY_S;
    if ((await store.countRequest(`invites:${caller.userId}`, dayStart, DAY_S)) > config.rateLimits.invitesPerDay) {
      throw new ToolError(`You've sent ${config.rateLimits.invitesPerDay} invites today, the most allowed. Try again tomorrow.`);
    }
    return true;
  }

  #inviteDates(g: { startsAt?: string; expiresAt?: string }) {
    return { ...(g.startsAt ? { startsAt: g.startsAt } : {}), ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}) };
  }

  // Adds an email to a tier of a site, or replaces its dates (M6 R153). They
  // may then open every rule listing the tier, after signing in, within the
  // dates. An invite goes to the email, at most hourly per tier.
  async addMember(caller: Caller, input: { siteId: string; email: string; tier: string; startsAt?: string; expiresAt?: string; confirmMember: boolean }) {
    const site = await this.#ownSite(caller, input.siteId);
    this.#assertChangeable(site);
    const email = input.email.trim().toLowerCase();
    const owner = await this.#d.store.getUser(caller.userId);
    if (email === owner?.email) throw new ToolError('That\'s your own email: you can open every part of the site already.');
    if (email.includes('#')) throw new ToolError('Passa can\'t add an email that has # in it.');
    if (!isTierName(input.tier)) throw new ToolError('A tier is 1 to 30 lowercase letters, digits and hyphens, such as gold; public, private and shared are taken.');
    if (!input.confirmMember) {
      throw new ToolError(`This would let ${email} open every part of the site open to ${input.tier} after signing in, and email them an invite. Read the address back to the person exactly as written here, `
        + 'since a typo gives members\' pages to a stranger, then call again with confirm_member set to true.');
    }
    const dates = this.#grantDates(input, false);
    const { mailer, store } = this.#d;
    if (!mailer) throw new ToolError('This deployment can\'t send email, so it can\'t send the invite.');
    const now = this.#now();
    const existing = await store.getMembership(site.id, email, input.tier);
    const resend = await this.#mayInvite(caller, existing);
    const membership: Membership = {
      siteId: site.id, email, tier: input.tier,
      createdAt: existing?.createdAt ?? now.toISOString(),
      ...dates,
      ...(resend ? { invitedAt: now.toISOString() } : existing?.invitedAt ? { invitedAt: existing.invitedAt } : {}),
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    await store.putMembership(membership);
    // New dates may begin later or end sooner: cookies check again.
    if (existing) await this.#revoke(site.id);
    const rules = (site.rules ?? []).filter((r) => r.access !== 'private' && r.access.includes(input.tier));
    if (resend) await mailer.send(inviteEmail({ to: email, from: owner?.email ?? 'Someone', url: this.#url(site), member: true, ...this.#inviteDates(membership) }));
    return {
      site_id: site.id,
      url: this.#url(site),
      member: memberOf(membership),
      tier_urls: rules.map((r) => this.#url(site) + r.path.slice(1)),
      ...(rules.length ? {} : { tier_note: `No rule lists ${input.tier} yet, so this membership opens nothing until one does.` }),
      invite_sent: resend,
      ...(resend ? {} : { invite_note: 'An invite for this tier went to this email less than an hour ago, so another wasn\'t sent.' }),
    };
  }

  // Removes one membership, or every membership of the email, and makes every
  // cookie for the site check again, so their next request is refused (M6 R154).
  async removeMember(caller: Caller, input: { siteId: string; email: string; tier?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    const email = input.email.trim().toLowerCase();
    const removed = await this.#d.store.deleteMemberships(site.id, email, input.tier);
    if (!removed) throw new ToolError(input.tier ? `That email isn't a member of ${input.tier}.` : 'That email isn\'t a member of any tier of the site.');
    await this.#revoke(site.id);
    return { site_id: site.id, email, ...(input.tier ? { tier: input.tier } : {}), removed };
  }

  // A site's memberships, a page at a time (M6 R155). Ended ones DynamoDB
  // hasn't removed yet are left out: they no longer open anything.
  async listMembers(caller: Caller, input: { siteId: string; tier?: string; limit?: number; cursor?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    const now = this.#now().toISOString();
    const page = await this.#page(() => this.#d.store.listMemberships(site.id, {
      limit: input.limit ?? MEMBERS_PAGE, ...(input.tier ? { tier: input.tier } : {}), ...(input.cursor ? { cursor: input.cursor } : {}),
    }));
    return {
      site_id: site.id,
      tiers: tiersOf(site.rules ?? []),
      members: page.items.filter((m) => !m.expiresAt || m.expiresAt > now).map(memberOf),
      ...(page.cursor ? { next_cursor: page.cursor } : {}),
    };
  }

  // Every share across the caller's sites, soonest end first, so forgotten
  // ones are easy to find (M6 R165).
  async listShares(caller: Caller, input: { endingWithinDays?: number; siteId?: string; limit?: number; cursor?: string }) {
    const site = input.siteId ? await this.#ownSite(caller, input.siteId) : undefined;
    const now = this.#now();
    const page = await this.#page(() => this.#d.store.listOwnerShares(caller.userId, {
      limit: input.limit ?? MEMBERS_PAGE,
      ...(input.endingWithinDays ? { before: new Date(now.getTime() + input.endingWithinDays * DAY_S * 1000).toISOString() } : {}),
      ...(site ? { siteId: site.id } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }));
    const sites = new Map((await this.#d.store.listSitesByOwner(caller.userId)).map((s) => [s.id, s]));
    return {
      shares: page.items.flatMap((g) => {
        const s = sites.get(g.siteId);
        return s && (g.expiresAt ?? '') > now.toISOString() ? [{ site_id: g.siteId, url: this.#url(s) + g.path.slice(1), ...shareOf(g) }] : [];
      }),
      ...(page.cursor ? { next_cursor: page.cursor } : {}),
    };
  }

  async #page<T>(query: () => Promise<T>): Promise<T> {
    try {
      return await query();
    } catch (err) {
      if (err instanceof BadCursor) throw new ToolError('That cursor isn\'t one Passa returned. Start again without it.');
      throw err;
    }
  }

  // Removes one shared path, or every path shared with the email, and makes
  // every cookie for the site check again, so the email's next request is
  // refused (M5 R131). The rules stay as they are.
  async unshare(caller: Caller, input: { siteId: string; email: string; path?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    const email = input.email.trim().toLowerCase();
    const removed = await this.#d.store.deleteGrants(site.id, email, input.path);
    if (!removed) throw new ToolError(input.path ? `${input.path} isn't shared with that email.` : 'The site isn\'t shared with that email.');
    await this.#revoke(site.id);
    return { site_id: site.id, email, ...(input.path ? { path: input.path } : {}), unshared: removed };
  }

  // After DynamoDB removes an ended share or membership (M5 R133, M6 R158):
  // as removing it.
  async expireGrant(siteId: string): Promise<void> {
    await this.#revoke(siteId);
  }

  async #revoke(siteId: string) {
    await this.#d.store.bumpAccessVersion(siteId, this.#now().toISOString());
    await this.#sync(siteId);
  }

  // The site's rules and who it's shared with (M5 R132). Expired shares
  // DynamoDB hasn't removed yet are left out: they no longer open anything.
  async listAccess(caller: Caller, input: { siteId: string; email?: string }) {
    const site = await this.#ownSite(caller, input.siteId);
    const now = this.#now();
    const rules = site.rules ?? [];
    const grants = (await this.#d.store.listGrants(site.id)).filter((g) => !g.expiresAt || g.expiresAt > now.toISOString());
    const { public: open, members } = regions(rules);
    // A share opens the rule at its path (M6 R156); with that rule gone, it opens nothing.
    const opensNothing = grants.filter((g) => !rules.some((r) => r.path === g.path));
    return {
      site_id: site.id,
      url: this.#url(site),
      access: accessOf(rules),
      rules,
      tiers: tiersOf(rules),
      public_urls: open.map((p) => this.#url(site) + p.slice(1)),
      member_urls: members.map((p) => this.#url(site) + p.slice(1)),
      shares: grants.map((g) => ({ ...shareOf(g), ...(opensNothing.includes(g) ? { opens_nothing: true } : {}) })),
      ...(opensNothing.length ? { note: 'Shares marked opens_nothing have no rule at their path any more, so they open nothing until one is set again.' } : {}),
      ...(input.email ? { as: await this.#accessAs(site, input.email.trim().toLowerCase()) } : {}),
    };
  }

  // What one email opens on a site and why, and the restricted paths it
  // doesn't (M6 R159): each rule's path, and / when no rule covers it.
  async #accessAs(site: Site, email: string): Promise<{ email: string; opens: PathAccess[]; closed: PathAccess[] }> {
    const owner = await this.#d.store.getUser(site.ownerId);
    const rules = site.rules ?? [];
    const paths = [...(rules.some((r) => r.path === '/') ? [] : [{ path: '/', access: 'private' as const, ruleless: true }]), ...rules].sort((a, b) => a.path.localeCompare(b.path));
    const url = (path: string) => this.#url(site) + path.slice(1);
    if (email === owner?.email) return { email, opens: paths.map((r) => ({ path: r.path, url: url(r.path), why: 'owner: opens everything' })), closed: [] };
    const now = this.#now();
    const [shares, memberships] = await Promise.all([this.#d.store.grantsFor(site.id, email), this.#d.store.membershipsFor(site.id, email)]);
    const ended = (g: { expiresAt?: string }) => !!g.expiresAt && g.expiresAt <= now.toISOString();
    const opens: PathAccess[] = [];
    const closed: PathAccess[] = [];
    for (const r of paths) {
      const at = { path: r.path, url: url(r.path) };
      if (isPublicAccess(r.access)) {
        opens.push({ ...at, why: 'public' });
        continue;
      }
      const tiers = memberships.filter((m) => !ended(m) && r.access !== 'private' && r.access.includes(m.tier));
      const share = shares.find((g) => !ended(g) && g.path === r.path);
      const live = [...tiers.filter((m) => grantIsLive(m, now)).map((m) => `member of ${m.tier}`), ...(share && grantIsLive(share, now) ? [`shared ${share.path}`] : [])];
      if (live.length) {
        opens.push({ ...at, why: live.join('; ') });
        continue;
      }
      // Grants that would open it but haven't begun yet.
      const later = [...tiers.map((m) => ({ what: `member of ${m.tier}`, at: m.startsAt })), ...(share ? [{ what: `shared ${share.path}`, at: share.startsAt }] : [])];
      const audience = 'ruleless' in r ? 'no rule: only you' : r.access === 'private' ? 'private' : `for ${r.access.join(', ')}`;
      closed.push({ ...at, why: later.length ? `${audience}; ${later.map((l) => `${l.what} from ${l.at ?? ''}`).join('; ')}` : audience });
    }
    return { email, opens, closed };
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
    const site = await this.#d.store.getSite(siteId);
    await this.#d.edge.remove(siteId);
    for (const { name } of await this.#d.store.namesOf(siteId)) await this.#d.edge.removeName(name);
    for (const domain of site?.domains ?? []) await this.#d.edge.removeDomain(domain);
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
    // A Markdown site's absolute links and feed follow the name (M3 R84). Its
    // rules haven't changed, so the current version already passed R89.
    const renamed = (await this.#d.store.getSite(site.id)) ?? site;
    const rendered = await this.#rerender(caller, renamed, await this.#version(renamed), { rules: renamed.rules ?? [], confirmPublic: true });
    // The new name before the site record, so its redirect has somewhere to go.
    if (to) await this.syncName(to);
    const updated = (await this.#sync(site.id)) ?? site;
    if (site.name) await this.syncName(site.name);
    return {
      ...this.#summary(updated),
      name_change: { from: site.name ?? null, to: to ?? null },
      ...(rendered ?? {}),
      ...(site.name ? { held: { name: site.name, until: holdUntil, note: 'The old name redirects here until then, and only you can claim it again.' } } : {}),
    };
  }

  // Sets which live custom domains serve a site, and its primary (M4 R114,
  // R117), rendering its Markdown again for the new address (R124). Not an MCP
  // tool: the admin function calls it, once a domain serves or before it goes.
  // Each step can be repeated, so a call that fails part-way is simply made
  // again: new domains reach the edge first, the render comes before the site
  // records the change (so a failed render leaves nothing half done), and
  // removed domains leave the edge last. force renders even when the primary
  // looks unchanged, to finish a switch an earlier call didn't.
  async setDomains(siteId: string, domains: string[], primary: string | undefined, options: { force?: boolean } = {}) {
    const site = await this.#d.store.getSite(siteId);
    if (!site || site.status === 'deleting') throw new ToolError(NOT_FOUND);
    if (primary ? !domains.includes(primary) : domains.length > 0) throw new ToolError('The primary domain must be one of the site\'s domains.');
    const before = site.domains ?? [];
    for (const domain of domains) if (!before.includes(domain)) await this.#d.edge.putDomain(domain, siteId);
    // The site as it will be, for the render's absolute URLs.
    const target: Site = { ...site, domains, ...(primary ? { domain: primary } : {}) };
    if (!primary) delete target.domain;
    // The rules haven't changed, so the current version already passed R89.
    const rendered = (primary !== site.domain || options.force) && site.status === 'active'
      ? await this.#rerender({ userId: site.ownerId }, target, await this.#version(site), { rules: site.rules ?? [], confirmPublic: true })
      : undefined;
    await this.#d.store.setSiteDomains(siteId, domains, primary, this.#now().toISOString());
    const synced = (await this.#sync(siteId)) ?? site;
    for (const domain of before) if (!domains.includes(domain)) await this.#d.edge.removeDomain(domain);
    return { ...this.#summary(synced), ...(rendered ?? {}) };
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

  // With a site, the files are a folder to sync: files whose path, size and
  // hash match the current version get no upload URL, and the version's files
  // the folder doesn't have are listed for removal. A folder that matches
  // exactly needs no upload at all.
  async beginUpload(caller: Caller, input: { files: { path: string; size: number; sha256?: string }[]; siteId?: string }) {
    const { config } = this.#d;
    const { keep, skipped } = checkManifest(input.files.map(({ path, size }) => ({ path, size })), config.limits, config.limits.site);
    let files = input.files.filter((f) => keep.has(f.path));
    let sync: UploadSync | undefined;
    let unchanged = 0;
    if (input.siteId) {
      const site = await this.#ownSite(caller, input.siteId);
      this.#assertChangeable(site);
      const base = await this.#version(site);
      // A folder holds sources and plain files; Passa renders the rest (M3 R87).
      const authored = base.files.filter((f) => f.role !== 'rendered');
      const current = new Map(authored.map((f) => [f.path, f]));
      // Cards the site already has are unchanged too, wherever the folder has them.
      const cards = files.some((f) => cardHash(f.path)) ? await this.#d.files.listCards(site.id) : new Set<string>();
      const same = (f: { path: string; size: number; sha256?: string }) =>
        cards.has(cardHash(f.path) ?? '') || (current.get(f.path)?.sha256 === f.sha256 && current.get(f.path)?.size === f.size);
      const inFolder = new Set(files.map((f) => f.path));
      const remove = authored.filter((f) => !inFolder.has(f.path)).map((f) => f.path);
      unchanged = files.filter((f) => (f.sha256 || cardHash(f.path)) && same(f)).length;
      files = files.filter((f) => !(f.sha256 || cardHash(f.path)) || !same(f));
      if (!files.length && !remove.length) return { site_id: site.id, up_to_date: true, version: base.id, skipped };
      sync = { siteId: site.id, baseVersion: base.id, remove };
    }
    const now = this.#now();
    const uploadId = newUploadId();
    const expiresAt = new Date(now.getTime() + config.lifetimes.uploadUrl * 1000).toISOString();
    const listed = files.map(({ path, size }) => ({ path, size }));
    await this.#d.store.putUpload({ id: uploadId, ownerId: caller.userId, files: listed, status: 'pending', createdAt: now.toISOString(), expiresAt, ...(sync ? { sync } : {}) });
    const uploads = await Promise.all(listed.map(async (f) => ({
      path: f.path,
      method: 'PUT' as const,
      url: await this.#d.files.presignUpload(uploadId, f.path, f.size, config.lifetimes.uploadUrl),
      headers: { 'Content-Length': String(f.size) },
    })));
    return {
      upload_id: uploadId,
      expires_at: expiresAt,
      uploads,
      skipped,
      ...(sync ? { sync: { base_version: sync.baseVersion, unchanged, remove: sync.remove } } : {}),
    };
  }

  // Confirms every listed file arrived at its declared size, so publish and
  // update can fail early and clearly.
  async finishUpload(caller: Caller, input: { uploadId: string }) {
    const upload = await this.#getUpload(caller, input.uploadId);
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
