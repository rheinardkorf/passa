import { describe, expect, it } from 'vitest';
import { versionsToKeep } from './retention.ts';

const retention = { versionDays: 30, monthEndMonths: 24, timeZone: 'UTC' };
const now = new Date('2026-10-31T12:00:00Z');
const v = (id: string, createdAt: string) => ({ id, createdAt });
const kept = (versions: { id: string; createdAt: string }[], current: string, r = retention) => [...versionsToKeep(versions, current, now, r)].sort();

describe('versionsToKeep', () => {
  it('keeps every version from the last 30 days, and drops older ones that aren\'t a month\'s last', () => {
    expect(kept([v('a', '2026-10-30T00:00:00Z'), v('b', '2026-10-02T00:00:00Z'), v('c', '2026-10-01T11:59:59Z')], 'a')).toEqual(['a', 'b']);
  });

  it('keeps only the last version of each older month', () => {
    const versions = [v('aug1', '2026-08-01T00:00:00Z'), v('aug2', '2026-08-31T23:59:59Z'), v('sep1', '2026-09-10T00:00:00Z'), v('sep2', '2026-09-20T00:00:00Z')];
    expect(kept(versions, 'sep2')).toEqual(['aug2', 'sep2']);
  });

  it('keeps month-end versions for 24 months, counting this month', () => {
    const versions = [v('nov24', '2024-11-30T00:00:00Z'), v('oct24', '2024-10-31T00:00:00Z'), v('now', '2026-10-31T00:00:00Z')];
    expect(kept(versions, 'now')).toEqual(['nov24', 'now']);
  });

  it('always keeps the current version, however old', () => {
    expect(kept([v('old', '2020-01-01T00:00:00Z'), v('older', '2019-01-01T00:00:00Z')], 'older')).toEqual(['older']);
  });

  it('counts months in the configured time zone', () => {
    // 1 September 01:00 in Sydney is still 31 August in UTC.
    const versions = [v('aug', '2026-08-20T00:00:00Z'), v('sep-sydney', '2026-08-31T15:00:00Z')];
    expect(kept(versions, 'x')).toEqual(['sep-sydney', 'x']);
    expect(kept(versions, 'x', { ...retention, timeZone: 'Australia/Sydney' })).toEqual(['aug', 'sep-sydney', 'x']);
  });

  it('keeps nothing extra with no month-end retention', () => {
    expect(kept([v('aug', '2026-08-31T00:00:00Z'), v('now', '2026-10-31T00:00:00Z')], 'now', { ...retention, monthEndMonths: 0 })).toEqual(['now']);
  });
});
