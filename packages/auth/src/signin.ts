// Magic-link sign-in, auth. sessions and the handoff to site cookies (R15–R19).
// HTTP lives in app.ts; this is the logic and what it records.
import { createHash, randomBytes } from 'node:crypto';
import {
  type Config,
  type Events,
  handoffUrl,
  type SigningKey,
  type Site,
  siteDomain,
  type Store,
  type User,
} from '@passa/shared';
import type { Mailer } from './mailer.ts';
import { magicLinkEmail, type Target } from './pages.ts';

export type Urls = {
  auth: string; // the auth. origin
  site: (siteId: string) => string; // a site's origin
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
  return { auth: `https://auth.${config.domain}`, site: (siteId) => `https://${siteId}.${siteDomain(config)}` };
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

  // M1: only a site's owner may view it, and only while it's active.
  async #viewableSite(user: User, siteId: string): Promise<Site | undefined> {
    const site = await this.#d.store.getSite(siteId);
    return site && site.status === 'active' && site.ownerId === user.id ? site : undefined;
  }

  // Always resolves the same way, whether or not an email is sent (R15).
  // Requests over the rate limit count but send nothing (R20).
  async requestLink(input: { email: string; ip: string; target?: Target | undefined }): Promise<void> {
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
    const base = { action: 'signin.request', email, ip: input.ip, ...(input.target ? { siteId: input.target.siteId } : {}) };
    if (byEmail > signinPerEmail || byIp > signinPerIp) {
      await events.record({ ...base, result: 'refused', detail: 'rate limited' });
      return;
    }

    const user = await store.findUserByEmail(email);
    const allowed = !!user && user.status === 'active' && (!input.target || !!(await this.#viewableSite(user, input.target.siteId)));
    if (!user || !allowed) {
      await events.record({ ...base, result: 'refused', detail: 'no access' });
      return;
    }

    const token = secret();
    const createdAt = new Date(now);
    await store.putSignInToken(sha256(token), {
      userId: user.id,
      ...(input.target ? { siteId: input.target.siteId, path: input.target.path } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(now + config.lifetimes.magicLink * 1000).toISOString(),
    });
    // The token goes in the fragment, which browsers never send to a server (R16).
    const message = magicLinkEmail({ link: `${this.urls.auth}/signin/continue#t=${token}`, minutes: Math.round(config.lifetimes.magicLink / 60) });
    await this.#d.mailer.send({ to: email, ...message });
    await events.record({ ...base, userId: user.id, result: 'ok' });
  }

  // Uses up a magic-link token and starts a new session with a fresh ID (R16, R18).
  async continue(input: { token: string; ip: string }): Promise<(SessionUser & { target?: Target }) | undefined> {
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
    const target = token.siteId && token.path ? { siteId: token.siteId, path: token.path } : undefined;
    return { user, sessionId, ...(target ? { target } : {}) };
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
    const site = await this.#viewableSite(user, target.siteId);
    if (!site) {
      await this.#d.events.record({ action: 'site.view', result: 'refused', userId: user.id, siteId: target.siteId, ip });
      return undefined;
    }
    return handoffUrl({
      key: await this.#d.siteKey(),
      siteId: site.id,
      accessVersion: site.accessVersion,
      origin: this.urls.site(site.id),
      path: target.path,
      cookieLifetime: this.#d.config.lifetimes.siteCookie,
      now: this.#now(),
    });
  }
}
