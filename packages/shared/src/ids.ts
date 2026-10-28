import { randomBytes } from 'node:crypto';

// Site IDs appear in every URL, so they are fully random. Lowercase only (they
// are DNS labels), without look-alike characters (0, o, 1, l).
const SITE_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SITE_ID_LENGTH = 12; // 12 × 5 bits = 60 random bits

export function newSiteId(): string {
  // The alphabet has 32 characters, so taking each byte modulo 32 is unbiased.
  return Array.from(randomBytes(SITE_ID_LENGTH), (b) => SITE_ID_ALPHABET[b % SITE_ID_ALPHABET.length]).join('');
}

export function isSiteId(value: string): boolean {
  return value.length === SITE_ID_LENGTH && [...value].every((c) => SITE_ID_ALPHABET.includes(c));
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
