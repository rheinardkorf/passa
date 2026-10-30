import { describe, expect, it } from 'vitest';
import { isSiteId, isVersionId, newSiteId, newVersionId } from './ids.ts';
import { ADJECTIVES, NOUNS } from './words.ts';

describe('site IDs', () => {
  it('are <adjective>-<noun>-<6 random characters>, valid as DNS labels', () => {
    for (let i = 0; i < 1000; i++) {
      const id = newSiteId();
      const [adjective, noun, random] = id.split('-');
      expect(ADJECTIVES).toContain(adjective);
      expect(NOUNS).toContain(noun);
      expect(random).toMatch(/^[bcdfghjkmnpqrstvwxyz2-9]{6}$/);
      expect(id.length).toBeLessThanOrEqual(63);
      expect(isSiteId(id)).toBe(true);
    }
  });

  it('use every random character, and only those', () => {
    const seen = new Set(Array.from({ length: 2000 }, newSiteId).flatMap((id) => [...(id.split('-')[2] ?? '')]));
    expect([...seen].sort().join('')).toBe('23456789bcdfghjkmnpqrstvwxyz');
  });

  it('do not repeat', () => {
    const ids = new Set(Array.from({ length: 10_000 }, newSiteId));
    expect(ids.size).toBe(10_000);
  });

  it('rejects anything else, including the old format and names', () => {
    for (const value of ['k3x9q2abcdef', 'cv', 'my-cv', 'brave-otter', 'brave-otter-k3x9q', 'brave-otter-k3x9qma', 'brave-otter-k3a9qm', 'Brave-otter-k3x9qm', 'brave-otter-k3x1qm', 'brave--k3x9qm']) {
      expect(isSiteId(value), value).toBe(false);
    }
    expect(isSiteId('brave-otter-k3x9qm')).toBe(true);
  });
});

describe('word lists', () => {
  it('have 512 distinct words of 3-6 lowercase letters each, none in both', () => {
    for (const words of [ADJECTIVES, NOUNS]) {
      expect(new Set(words).size).toBe(512);
      for (const w of words) expect(w).toMatch(/^[a-z]{3,6}$/);
    }
    expect(ADJECTIVES.filter((w) => (NOUNS as readonly string[]).includes(w))).toEqual([]);
  });
});

describe('version IDs', () => {
  it('are ULIDs that sort by creation time', () => {
    const earlier = newVersionId(1_700_000_000_000);
    const later = newVersionId(1_700_000_000_001);
    expect(isVersionId(earlier)).toBe(true);
    expect(earlier < later).toBe(true);
  });

  it('encode the timestamp in the first 10 characters', () => {
    expect(newVersionId(0).slice(0, 10)).toBe('0000000000');
    expect(newVersionId(1_469_918_176_385).slice(0, 10)).toBe('01ARYZ6S41');
  });

  it('rejects anything else', () => {
    expect(isVersionId('not-a-ulid')).toBe(false);
    expect(isVersionId('8ZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false);
  });
});
