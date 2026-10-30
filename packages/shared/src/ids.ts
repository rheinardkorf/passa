import { randomBytes, randomInt } from 'node:crypto';
import { ADJECTIVES, NOUNS } from './words.ts';

// Site IDs appear in every URL: <adjective>-<noun>-<6 random characters>, such
// as brave-otter-k3x9qm. Two words from lists of 512 (9 bits each) and 6
// characters from 28 (about 29 bits): about 47 bits in all. The random part has
// no vowels, so it can't spell words, and no look-alikes (0, 1, l, o).
const SITE_ID_RANDOM = 'bcdfghjkmnpqrstvwxyz23456789';
const SITE_ID_RANDOM_LENGTH = 6;

// The shape alone tells a site ID from a name (M2 R43, R44); names can't match
// it. The edge handler has the same pattern, and a test keeps them equal.
export const SITE_ID_PATTERN = /^[a-z]{3,6}-[a-z]{3,6}-[b-df-hj-km-np-tv-z2-9]{6}$/;

const pick = <T>(items: readonly T[]): T => items[randomInt(items.length)] as T;

export function newSiteId(): string {
  const random = Array.from({ length: SITE_ID_RANDOM_LENGTH }, () => pick([...SITE_ID_RANDOM])).join('');
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${random}`;
}

export function isSiteId(value: string): boolean {
  return SITE_ID_PATTERN.test(value);
}

// Version IDs are ULIDs: 48 bits of millisecond time, then 80 random bits, in
// Crockford base32. They sort by creation time and are only shown to owners.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_TIME_CHARS = 10;
const ULID_RANDOM_BYTES = 10;

export function newVersionId(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const b of randomBytes(ULID_RANDOM_BYTES)) bits = (bits << 8n) | BigInt(b);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random = CROCKFORD[Number(bits & 31n)] + random;
    bits >>= 5n;
  }
  return time + random;
}

export function isVersionId(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}

// User IDs are stable and never derived from the email, so an email can change
// without changing who owns what.
export function newUserId(): string {
  return `u_${randomBytes(16).toString('base64url')}`;
}

// Upload IDs are bearer-like references to a pending upload, so they carry
// 128 random bits. They are still only usable by the publisher who began them.
export function newUploadId(): string {
  return randomBytes(16).toString('base64url');
}

export function isUploadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(value);
}
