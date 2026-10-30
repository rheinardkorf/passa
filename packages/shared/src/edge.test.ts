import { describe, expect, it } from 'vitest';
import type { Site } from './db.ts';
import { edgeRecord } from './edge.ts';
import { checkRules, MAX_EDGE_RULES_BYTES, type Rule } from './rules.ts';

const site: Site = {
  id: 'brave-otter-k3x9qm',
  ownerId: 'alice',
  title: 't',
  current: '01JB0000000000000000000000',
  accessVersion: 999_999,
  status: 'active',
  createdAt: '2026-10-31T00:00:00Z',
  updatedAt: '2026-10-31T00:00:00Z',
};

describe('edgeRecord', () => {
  it('fits in a KeyValueStore value (1 KB) with the longest name and rules allowed', () => {
    // Rules as long as checkRules allows together.
    const rules: Rule[] = [{ path: '/', tier: 'public' }];
    const next = (i: number): Rule => ({ path: `/${'a'.repeat(30)}${i}/`, tier: 'private' });
    for (let i = 0; checkRules([...rules, next(i)]).length === 0; i++) rules.push(next(i));
    const record = edgeRecord({ ...site, rules, name: 'n'.repeat(40) });
    expect(JSON.stringify(record?.r).length).toBeLessThanOrEqual(MAX_EDGE_RULES_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(record)).byteLength).toBeLessThanOrEqual(1024);
  });

  it('carries the name only when the site has one, and nothing for inactive sites', () => {
    expect(edgeRecord(site)).toEqual({ cur: site.current, v: site.accessVersion, r: [] });
    expect(edgeRecord({ ...site, name: 'cv' })?.n).toBe('cv');
    expect(edgeRecord({ ...site, status: 'blocked', name: 'cv' })).toBeUndefined();
  });
});
