import { describe, expect, it } from 'vitest';
import { loadConfigFile } from './config.ts';
import { ENV, runtimeEnv, viewerAddress } from './runtime.ts';

const config = loadConfigFile(new URL('../../../config.example.yml', import.meta.url).pathname);
const env = {
  [ENV.config]: JSON.stringify(config),
  [ENV.table]: 't',
  [ENV.eventsTable]: 'e',
  [ENV.sitesBucket]: 's',
  [ENV.uploadsBucket]: 'u',
  [ENV.tokenKey]: 'alias/k',
  [ENV.authSecret]: 'secret',
  [ENV.edgeStore]: 'arn:kvs',
};

describe('runtime environment', () => {
  it('reads every resource name, and the configuration set only when set', () => {
    const read = runtimeEnv(env);
    expect([read.config.domain, read.tables, read.buckets, read.edgeStore]).toEqual(['example.com', { main: 't', events: 'e' }, { sites: 's', uploads: 'u' }, 'arn:kvs']);
    expect(read).not.toHaveProperty('configurationSet');
    expect(runtimeEnv({ ...env, [ENV.configurationSet]: 'cs' }).configurationSet).toBe('cs');
  });

  it('fails clearly when something is missing', () => {
    expect(() => runtimeEnv({ ...env, [ENV.table]: undefined })).toThrow(`${ENV.table} is not set`);
  });

  it('takes the IP from CloudFront-Viewer-Address, IPv4 or IPv6', () => {
    expect(viewerAddress('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(viewerAddress('2001:db8::1:443')).toBe('2001:db8::1');
    expect(viewerAddress(undefined)).toBe('');
  });
});
