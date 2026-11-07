// Signs the tokens the edge handler accepts. Must match packages/edge/src/handler.js
// exactly: HMAC-SHA256 in hex over "<purpose>.<fields joined by dots>".
import { createHmac } from 'node:crypto';

export type SigningKey = { kid: string; secret: string };

// Paths the edge will serve, the same rule as PATH in edge/src/handler.js.
const SITE_PATH = /^(\/[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*)*\/?$/;
export const isSitePath = (path: string): boolean => path.startsWith('/') && SITE_PATH.test(path);

// Handoff tokens are only valid briefly: long enough to follow one redirect.
export const HANDOFF_TTL_S = 60;

// What a cookie lets its holder open on a site (M5 R136): o, the owner, opens
// every path; s-<id>-<id>…, someone the site is shared with, opens the shared
// rules with those IDs (ruleId). Public paths need no cookie at all.
export type SiteTiers = 'o' | `s-${string}`;
export const MAX_VIEWER_RULES = 20;
export const viewerTiers = (ids: string[]): SiteTiers => `s-${ids.slice(0, MAX_VIEWER_RULES).join('-')}`;

const sign = (key: SigningKey, purpose: string, fields: (string | number)[]) =>
  createHmac('sha256', key.secret).update(`${purpose}.${fields.join('.')}`).digest('hex');

// The viewer's email in the cookie (M7 R178), so the edge can say who's signed
// in: hex of its UTF-8, which the edge decodes without Buffer and which never
// contains the dots fields are joined with.
export const MAX_EMAIL_LENGTH = 254;
export const emailField = (email: string): string => Buffer.from(email.slice(0, MAX_EMAIL_LENGTH), 'utf8').toString('hex');

// The URL auth. sends a signed-in visitor to. The edge turns it into a site
// cookie that lasts cookieLifetime seconds, then redirects to path.
export function handoffUrl(input: {
  key: SigningKey;
  siteId: string;
  accessVersion: number;
  origin: string; // e.g. https://<site-id>.<domain>
  path: string;
  cookieLifetime: number;
  tiers: SiteTiers;
  email: string;
  now?: number; // ms
}): string {
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + HANDOFF_TTL_S;
  const fields = [input.key.kid, input.siteId, input.accessVersion, exp, input.tiers, emailField(input.email)];
  const token = `${fields.join('.')}.${sign(input.key, 'handoff', [...fields, input.cookieLifetime, input.path])}`;
  const query = new URLSearchParams({ t: token, l: String(input.cookieLifetime), p: input.path });
  return `${input.origin}/_passa/session?${query}`;
}

// Where auth.'s refresh sends someone it can't give a cookie (M7 R175): back
// to the page through the edge, which deletes the site cookie first, so a
// fragment's next request is a stranger's and can't loop. Signed, so a link
// can't sign anyone out of a site.
export function clearUrl(input: { key: SigningKey; siteId: string; origin: string; path: string; now?: number }): string {
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + HANDOFF_TTL_S;
  const token = `${input.key.kid}.${exp}.${sign(input.key, 'clear', [input.key.kid, input.siteId, exp, input.path])}`;
  return `${input.origin}/_passa/session?${new URLSearchParams({ c: token, p: input.path })}`;
}

// A site cookie value, as the edge issues it. Used by tests.
export function siteCookie(input: { key: SigningKey; siteId: string; accessVersion: number; expires: number; tiers: SiteTiers; email?: string }): string {
  const fields = [input.key.kid, input.siteId, input.accessVersion, input.expires, input.tiers, emailField(input.email ?? 'someone@example.com')];
  return `${fields.join('.')}.${sign(input.key, 'cookie', fields)}`;
}
