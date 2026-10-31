import { describe, expect, it } from 'vitest';
import { loadConfigFile, parseConfig, senderAddress, senderDomain, siteDomain, stageConfig } from './config.ts';

const example = loadConfigFile(new URL('../../../config.example.yml', import.meta.url).pathname);

describe('config', () => {
  it('parses the example config', () => {
    expect(example.domain).toBe('example.com');
  });

  it('serves sites from the main domain unless a site domain is set', () => {
    expect(siteDomain(example)).toBe('example.com');
    expect(siteDomain(parseConfig({ ...example, siteDomain: 'example-sites.com' }))).toBe('example-sites.com');
  });

  it('applies a stage’s overrides and keeps everything else', () => {
    const config = parseConfig({ ...example, stages: { dev: { domain: 'dev.example.com', siteDomain: 'dev.example-sites.com' } } });
    const dev = stageConfig(config, 'dev');
    expect([dev.domain, siteDomain(dev), dev.email.from]).toEqual(['dev.example.com', 'dev.example-sites.com', example.email.from]);
    expect(dev).not.toHaveProperty('stages');
    expect(stageConfig(config, 'prod').domain).toBe('example.com');
    expect(() => parseConfig({ ...example, stages: { dev: { region: 'us-east-1' } } })).toThrow();
  });

  it('reads the sender’s address and domain', () => {
    expect([senderAddress('Passa <no-reply@example.com>'), senderDomain('Passa <no-reply@example.com>')]).toEqual(['no-reply@example.com', 'example.com']);
    expect([senderAddress('no-reply@example.com'), senderDomain('no-reply@example.com')]).toEqual(['no-reply@example.com', 'example.com']);
  });

  it('keeps versions for 30 days, month-ends for 24 months and events for 7 years unless set, in a real time zone', () => {
    const rest: Record<string, unknown> = { ...example };
    delete rest.retention;
    expect(parseConfig(rest).retention).toEqual({ versionDays: 30, monthEndMonths: 24, timeZone: 'UTC', eventYears: 7 });
    expect(parseConfig({ ...example, retention: { ...example.retention, timeZone: 'Australia/Sydney' } }).retention.timeZone).toBe('Australia/Sydney');
    expect(() => parseConfig({ ...example, retention: { ...example.retention, timeZone: 'Mars/Olympus' } })).toThrow();
  });

  it('refuses site domains that are not plain domain names', () => {
    for (const bad of ['Example-Sites.com', 'localhost', 'example.com/x', '*.example.com', 'example.com:443']) {
      expect(() => parseConfig({ ...example, siteDomain: bad }), bad).toThrow();
    }
  });
});
