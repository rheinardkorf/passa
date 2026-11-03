import { describe, expect, it } from 'vitest';
import { behindCloudflare, checkDomain } from './domains.ts';

const deployment = { domain: 'passa.example', siteDomain: 'sites.example' };

describe('which domains can be attached (R114)', () => {
  it('takes lowercase hostnames, subdomains and apexes alike', () => {
    expect(checkDomain('docs.example.com', deployment)).toEqual({});
    expect(checkDomain('example.com', deployment)).toEqual({});
    expect(checkDomain('a-b.c-d.example.co.uk', deployment)).toEqual({});
  });

  it('refuses names that are not hostnames', () => {
    for (const bad of ['Docs.example.com', 'example', '-a.example.com', 'a-.example.com', 'a..example.com', 'a_b.example.com', '1.2.3.4', `${'a'.repeat(64)}.com`]) {
      expect(checkDomain(bad, deployment).problem, bad).toMatch(/isn't a valid domain name/);
    }
  });

  it('refuses the site domain, and warns about Passa’s own domain', () => {
    expect(checkDomain('blog.sites.example', deployment).problem).toMatch(/under the site domain/);
    expect(checkDomain('sites.example', deployment).problem).toMatch(/under the site domain/);
    expect(checkDomain('docs.passa.example', deployment)).toEqual({ warning: expect.stringMatching(/same-site with auth\.passa\.example/) });
  });
});

describe('Cloudflare-proxied addresses', () => {
  it('knows Cloudflare’s ranges and nothing else', () => {
    expect(behindCloudflare('104.16.0.1')).toBe(true);
    expect(behindCloudflare('172.67.200.9')).toBe(true);
    expect(behindCloudflare('13.224.181.92')).toBe(false); // CloudFront
    expect(behindCloudflare('not-an-ip')).toBe(false);
  });
});
