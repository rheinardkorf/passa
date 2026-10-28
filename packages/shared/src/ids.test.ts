import { describe, expect, it } from 'vitest';
import { isSiteId, isVersionId, newSiteId, newVersionId } from './ids.ts';

describe('site IDs', () => {
  it('are valid DNS labels without look-alike characters', () => {
    for (let i = 0; i < 1000; i++) {
      const id = newSiteId();
      expect(id).toMatch(/^[a-z2-9]{12}$/);
      expect(id).not.toMatch(/[01lo]/);
      expect(isSiteId(id)).toBe(true);
    }
  });

  it('do not repeat', () => {
    const ids = new Set(Array.from({ length: 10_000 }, newSiteId));
    expect(ids.size).toBe(10_000);
  });

  it('rejects anything else', () => {
    expect(isSiteId('ABCDEFGHJKMN')).toBe(false);
    expect(isSiteId('abc')).toBe(false);
    expect(isSiteId('abcdefghijk0')).toBe(false);
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
