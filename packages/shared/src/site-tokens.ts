// Signs the tokens the edge handler accepts. Must match packages/edge/src/handler.js
// exactly: HMAC-SHA256 in hex over "<purpose>.<fields joined by dots>".
import { createHmac } from 'node:crypto';

export type SigningKey = { kid: string; secret: string };

// Paths the edge will serve, the same rule as PATH in edge/src/handler.js.
const SITE_PATH = /^(\/[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*)*\/?$/;
export const isSitePath = (path: string): boolean => path.startsWith('/') && SITE_PATH.test(path);

// Handoff tokens are only valid briefly: long enough to follow one redirect.
export const HANDOFF_TTL_S = 60;

const sign = (key: SigningKey, purpose: string, fields: (string | number)[]) =>
  createHmac('sha256', key.secret).update(`${purpose}.${fields.join('.')}`).digest('hex');

// The URL auth. sends a signed-in visitor to. The edge turns it into a site
// cookie that lasts cookieLifetime seconds, then redirects to path.
export function handoffUrl(input: {
  key: SigningKey;
  siteId: string;
  accessVersion: number;
  origin: string; // e.g. https://<site-id>.<domain>
  path: string;
  cookieLifetime: number;
  now?: number; // ms
}): string {
  const exp = Math.floor((input.now ?? Date.now()) / 1000) + HANDOFF_TTL_S;
  const fields = [input.key.kid, input.siteId, input.accessVersion, exp];
  const token = `${fields.join('.')}.${sign(input.key, 'handoff', [...fields, input.cookieLifetime, input.path])}`;
  const query = new URLSearchParams({ t: token, l: String(input.cookieLifetime), p: input.path });
  return `${input.origin}/_passa/session?${query}`;
}

// A site cookie value, as the edge issues it. Used by tests.
export function siteCookie(input: { key: SigningKey; siteId: string; accessVersion: number; expires: number }): string {
  const fields = [input.key.kid, input.siteId, input.accessVersion, input.expires];
  return `${fields.join('.')}.${sign(input.key, 'cookie', fields)}`;
}
