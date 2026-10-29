import { describe, expect, it } from 'vitest';
import { loadConfigFile, parseConfig, siteDomain } from './config.ts';

const example = loadConfigFile(new URL('../../../config.example.yml', import.meta.url).pathname);

describe('config', () => {
  it('parses the example config', () => {
    expect(example.domain).toBe('example.com');
  });

  it('serves sites from the main domain unless a site domain is set', () => {
    expect(siteDomain(example)).toBe('example.com');
    expect(siteDomain(parseConfig({ ...example, siteDomain: 'example-sites.com' }))).toBe('example-sites.com');
  });

  it('refuses site domains that are not plain domain names', () => {
    for (const bad of ['Example-Sites.com', 'localhost', 'example.com/x', '*.example.com', 'example.com:443']) {
      expect(() => parseConfig({ ...example, siteDomain: bad }), bad).toThrow();
    }
  });
});
