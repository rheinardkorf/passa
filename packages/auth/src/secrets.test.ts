import { describe, expect, it } from 'vitest';
import { authSecretsSchema, completeAuthSecrets } from './secrets.ts';

describe('auth secrets', () => {
  it('generates everything for a new deployment', () => {
    const secrets = completeAuthSecrets('random string from Secrets Manager', 'k1');
    expect(authSecretsSchema.parse(secrets).siteKeys[0]?.kid).toBe('k1');
  });

  it('keeps valid keys and only adds what is missing', () => {
    const existing = { cookieKeys: ['c'.repeat(43)], siteKeys: [{ kid: 'old', secret: 's'.repeat(64) }] };
    const secrets = completeAuthSecrets(existing, 'new');
    expect(secrets.cookieKeys).toEqual(existing.cookieKeys);
    expect(secrets.siteKeys).toEqual(existing.siteKeys);
    expect(secrets.originVerify.length).toBeGreaterThanOrEqual(32);
    expect(completeAuthSecrets(secrets, 'other')).toEqual(secrets);
  });

  it('replaces only the part that is invalid', () => {
    const existing = { cookieKeys: ['short'], siteKeys: [{ kid: 'old', secret: 's'.repeat(64) }], originVerify: 'o'.repeat(43) };
    const secrets = completeAuthSecrets(existing, 'new');
    expect(secrets.cookieKeys).not.toEqual(existing.cookieKeys);
    expect([secrets.siteKeys, secrets.originVerify]).toEqual([existing.siteKeys, existing.originVerify]);
  });
});
