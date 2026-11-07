// Magic-link sign-in, auth. sessions and the handoff to site cookies (R15–R19).
// HTTP lives in app.ts; this is the logic and what it records.
import { createHash, randomBytes } from 'node:crypto';
import {
  type Config,
  type Events,
  grantIsLive,
  handoffUrl,
  isDomain,
  isName,
  isSiteId,
  newUserId,
  ruleFor,
  ruleId,
  servedPath,
  sharedRulesFor,
  type SigningKey,
  type SiteTiers,
  type Site,
  siteDomain,
  type Store,
  type User,
  viewerTiers,
} from '@passa/shared';
import type { Mailer } from './mailer.ts';
import { magicLinkEmail, type Next, type Target } from './pages.ts';

export type Urls = {
  auth: string; // the auth. origin
  mcp: string; // the mcp. origin; the MCP endpoint is <mcp>/mcp
  site: (label: string) => string; // a site's origin, by its ID or name
  domain?: (domain: string) => string; // a site's origin at its custom domain (M4)
};

export type SignInDeps = {
  store: Store;
  events: Events;
  config: Config;
  mailer: Mailer;
  // The current site cookie signing key, shared with the edge.
  siteKey: () => Promise<SigningKey>;
  urls?: Urls;
  now?: () => Date;
};

export type SessionUser = { user: User; sessionId: string };

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');

// Last-seen times are written at most this often, to save a write per request.
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export function defaultUrls(config: Config): Urls {
  return { auth: `https://auth.${config.domain}`, mcp: `https://mcp.${config.domain}`, site: (siteId) => `https://${siteId}.${siteDomain(config)}` };
}

export const isPublisher = (user: User) => user.status === 'active' && user.roles.includes('publisher');

const INTERACTION = /^[A-Za-z0-9_-]{1,64}$/;
export const isInteractionUid = (value: string) => INTERACTION.test(value);

function nextFields(next: Next | undefined) {
  if (!next) return {};
  return 'site' in next ? { siteId: next.site.siteId, path: next.site.path } : { interaction: next.interaction };
}

export class SignIn {
  readonly #d: SignInDeps;
  readonly urls: Urls;

  constructor(deps: SignInDeps) {
    this.#d = deps;
    this.urls = deps.urls ?? defaultUrls(deps.config);
  }

  #now(): number {
    return (this.#d.now?.() ?? new Date()).getTime();
  }

  // The site a label names, while it's active. A name counts only while it's
  // the site's current one (held names redirect at the edge), and a domain
  // only once it's live on the site (M4).
  async #site(label: string): Promise<Site | undefined> {
    const siteId = isSiteId(label) ? label
      : isName(label) ? (await this.#d.store.getName(label))?.siteId
      : isDomain(label) ? (await this.#d.store.getDomain(label))?.siteId : undefined;
    const site = siteId ? await this.#d.store.getSite(siteId) : undefined;
    if (isName(label) && site?.name !== label) return undefined;
    if (isDomain(label) && !site?.domains?.includes(label)) return undefined;
    return site?.status === 'active' ? site : undefined;
  }

  // What an email may open on a site: everything as its owner (o), or the
  // shared rules at or under the paths shared with it (M5 R135, R136).
  async #tiersFor(site: Site, user: { id: string; email: string } | undefined, email: string): Promise<SiteTiers | undefined> {
    if (user && site.ownerId === user.id) return 'o';
    const now = new Date(this.#now());
    const paths = (await this.#d.store.grantsFor(site.id, email)).filter((g) => grantIsLive(g, now)).map((g) => g.path);
    const rules = sharedRulesFor(site.rules ?? [], paths);
    return rules.length ? viewerTiers(rules.map((r) => ruleId(r.path))) : undefined;
  }

  async #viewableSite(user: User, label: string): Promise<{ site: Site; tiers: SiteTiers } | undefined> {
    const site = await this.#site(label);
    const tiers = site ? await this.#tiersFor(site, user, user.email) : undefined;
    return site && tiers ? { site, tiers } : undefined;
  }

  // Always resolves the same way, whether or not an email is sent (R15).
  // Requests over the rate limit count but send nothing (R20). For a site,
  // only people who can view it get an email; for an app, only publishers (R24).
  async requestLink(input: { email: string; ip: string; next?: Next | undefined }): Promise<void> {
    const { config, store, events } = this.#d;
    const email = input.email.trim().toLowerCase();
    const now = this.#now();
    const { window, signinPerEmail, signinPerIp } = config.rateLimits;
    const windowStart = Math.floor(now / 1000 / window) * window;
    // Hashed so the counters hold no addresses.
    const [byEmail, byIp] = await Promise.all([
      store.countRequest(`signin-email:${sha256(email)}`, windowStart, window),
      store.countRequest(`signin-ip:${sha256(input.ip)}`, windowStart, window),
    ]);
    const next = input.next;
    const base = { action: 'signin.request', email, ip: input.ip, ...(next && 'site' in next ? { siteId: next.site.siteId } : {}) };
    if (byEmail > signinPerEmail || byIp > signinPerIp) {
      await events.record({ ...base, result: 'refused', detail: 'rate limited' });
      return;
    }

    let user = await store.findUserByEmail(email);
    // Someone a site is shared with may have no account yet: they get one with
    // no roles, which can sign in to view but never publish (M5 R135).
    if (!user && next && 'site' in next) {
      const site = await this.#site(next.site.siteId);
      if (site && (await this.#tiersFor(site, undefined, email))) {
        user = { id: newUserId(), email, roles: [], status: 'active', createdAt: new Date(now).toISOString() };
        await store.putUser(user);
      }
    }
    const allowed = !!user && user.status === 'active'
      && (!next || ('site' in next ? !!(await this.#viewableSite(user, next.site.siteId)) : isPublisher(user)));
    if (!user || !allowed) {
      await events.record({ ...base, result: 'refused', detail: 'no access' });
      return;
    }

    const token = secret();
    const createdAt = new Date(now);
    await store.putSignInToken(sha256(token), {
      userId: user.id,
      ...nextFields(next),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(now + config.lifetimes.magicLink * 1000).toISOString(),
    });
    // The token goes in the fragment, which browsers never send to a server (R16).
    const message = magicLinkEmail({ link: `${this.urls.auth}/signin/continue#t=${token}`, minutes: Math.round(config.lifetimes.magicLink / 60) });
    await this.#d.mailer.send({ to: email, ...message });
    await events.record({ ...base, userId: user.id, result: 'ok' });
  }

  // Uses up a magic-link token and starts a new session with a fresh ID (R16, R18).
  async continue(input: { token: string; ip: string }): Promise<(SessionUser & { next?: Next }) | undefined> {
    const { store, events, config } = this.#d;
    const now = this.#now();
    const token = input.token ? await store.takeSignInToken(sha256(input.token), new Date(now).toISOString()) : undefined;
    const user = token ? await store.getUser(token.userId) : undefined;
    if (!token || !user || user.status !== 'active') {
      await events.record({ action: 'signin.continue', result: 'refused', ip: input.ip, ...(user ? { userId: user.id } : {}), detail: token ? 'not active' : 'invalid link' });
      return undefined;
    }

    const sessionId = secret();
    const iso = new Date(now).toISOString();
    const expiresAt = now + config.lifetimes.sessionMax * 1000;
    await store.putSession(sha256(sessionId), { userId: user.id, createdAt: iso, lastSeenAt: iso, expiresAt: new Date(expiresAt).toISOString() }, this.#ttl(now, expiresAt));
    await events.record({ action: 'signin.continue', result: 'ok', userId: user.id, email: user.email, ip: input.ip });
    const next: Next | undefined = token.siteId && token.path
      ? { site: { siteId: token.siteId, path: token.path } }
      : token.interaction ? { interaction: token.interaction } : undefined;
    return { user, sessionId, ...(next ? { next } : {}) };
  }

  // When DynamoDB may remove the session: whichever expiry comes first.
  #ttl(lastSeen: number, expiresAt: number): number {
    return Math.floor(Math.min(lastSeen + this.#d.config.lifetimes.sessionIdle * 1000, expiresAt) / 1000);
  }

  // The signed-in user, if the session is valid: not past its maximum
  // lifetime, not idle for too long, and the user still active.
  async session(sessionId: string | undefined): Promise<SessionUser | undefined> {
    if (!sessionId) return undefined;
    const { store, config } = this.#d;
    const now = this.#now();
    const hash = sha256(sessionId);
    const session = await store.getSession(hash);
    if (!session) return undefined;
    const lastSeen = Date.parse(session.lastSeenAt);
    const expiresAt = Date.parse(session.expiresAt);
    if (now >= expiresAt || now >= lastSeen + config.lifetimes.sessionIdle * 1000) return undefined;
    const user = await store.getUser(session.userId);
    if (!user || user.status !== 'active') return undefined;
    if (now - lastSeen > TOUCH_AFTER_MS) await store.touchSession(hash, new Date(now).toISOString(), this.#ttl(now, expiresAt));
    return { user, sessionId };
  }

  async endSession(sessionId: string, ip: string, userId?: string): Promise<void> {
    await this.#d.store.deleteSession(sha256(sessionId));
    if (userId) await this.#d.events.record({ action: 'signout', result: 'ok', userId, ip });
  }

  // Where to send a signed-in user who asked for a site: the edge's handoff
  // URL, which sets the site cookie. Undefined when they may not view it.
  async siteRedirect(user: User, target: Target, ip: string): Promise<string | undefined> {
    const viewable = await this.#viewableSite(user, target.siteId);
    // Someone the site is shared with is refused paths not shared with them
    // here: a cookie without them would only send them back (M5 R136).
    const rule = viewable ? ruleFor(viewable.site.rules ?? [], servedPath(target.path)) : undefined;
    const opens = viewable && (viewable.tiers === 'o' || rule?.tier === 'public'
      || (rule?.tier === 'shared' && viewable.tiers.split('-').includes(ruleId(rule.path))));
    if (!viewable || !opens) {
      await this.#d.events.record({ action: 'site.view', result: 'refused', userId: user.id, siteId: target.siteId, ip });
      return undefined;
    }
    const { site, tiers } = viewable;
    return handoffUrl({
      key: await this.#d.siteKey(),
      siteId: site.id,
      accessVersion: site.accessVersion,
      // The site's current address, from the database, never from the request
      // (M2 R45): its primary domain, else its name, else its ID (M4 R123).
      origin: site.domain ? (this.urls.domain ?? ((d: string) => `https://${d}`))(site.domain) : this.urls.site(site.name ?? site.id),
      path: target.path,
      cookieLifetime: this.#d.config.lifetimes.siteCookie,
      tiers,
      now: this.#now(),
    });
  }
}
