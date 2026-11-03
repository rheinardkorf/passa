import type { Route53Client } from '@aws-sdk/client-route-53';
import type { DnsRecord } from '@passa/shared';
import { describe, expect, it } from 'vitest';
import { pending, Route53Dns } from './dns.ts';

// Route 53 in memory: two zones, and the changes sent to them.
function fakeRoute53(opts: { missingOnDelete?: boolean } = {}) {
  const zones: Record<string, string> = { Z1: 'example.com.', Z2: 'docs.example.com.' };
  const changes: { zone: string; changes: unknown[] }[] = [];
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, any> }) { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (command.constructor.name === 'GetHostedZoneCommand') return { HostedZone: { Id: `/hostedzone/${command.input.Id}`, Name: zones[command.input.Id] } };
      if (opts.missingOnDelete && command.input.ChangeBatch.Changes[0].Action === 'DELETE') {
        throw Object.assign(new Error('Tried to delete resource record set but it was not found'), { name: 'InvalidChangeBatch' });
      }
      changes.push({ zone: command.input.HostedZoneId, changes: command.input.ChangeBatch.Changes });
      return {};
    },
  };
  return { dns: new Route53Dns(client as unknown as Route53Client, ['Z1', 'Z2']), changes };
}

const cname: DnsRecord = { name: 'blog.example.com', type: 'CNAME', value: 'd111.cloudfront.net', purpose: 'pointer' };
const alias: DnsRecord = { name: 'example.com', type: 'A', value: 'd111.cloudfront.net', alias: true, purpose: 'pointer' };

describe('Route 53 (R120)', () => {
  it('finds the closest configured zone, and none for other domains', async () => {
    const { dns } = fakeRoute53();
    expect(await dns.zoneFor('api.docs.example.com')).toEqual({ id: 'Z2', name: 'docs.example.com' });
    expect(await dns.zoneFor('example.com')).toEqual({ id: 'Z1', name: 'example.com' });
    expect(await dns.zoneFor('example.org')).toBeUndefined();
    expect(await dns.zoneFor('notexample.com')).toBeUndefined();
  });

  it('writes CNAMEs with a TTL, and apex pointers as aliases to CloudFront', async () => {
    const { dns, changes } = fakeRoute53();
    await dns.upsert([cname, alias]);
    expect(changes).toEqual([{ zone: 'Z1', changes: [
      { Action: 'UPSERT', ResourceRecordSet: { Name: 'blog.example.com', Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: 'd111.cloudfront.net' }] } },
      { Action: 'UPSERT', ResourceRecordSet: { Name: 'example.com', Type: 'A', AliasTarget: { HostedZoneId: 'Z2FDTNDATAQYW2', DNSName: 'd111.cloudfront.net', EvaluateTargetHealth: false } } },
    ] }]);
  });

  it('refuses records outside its zones, and ignores deleting records already gone', async () => {
    await expect(fakeRoute53().dns.upsert([{ ...cname, name: 'blog.example.org' }])).rejects.toThrow(/isn't in a Route 53 zone/);
    await expect(fakeRoute53({ missingOnDelete: true }).dns.remove([cname])).resolves.toBeUndefined();
  });
});

describe('checking public DNS', () => {
  const resolver = (cnames: Record<string, string[]>, ips: Record<string, string[]>) => ({
    resolveCname: async (n: string) => cnames[n] ?? Promise.reject(new Error('ENODATA')),
    resolve4: async (n: string) => ips[n] ?? Promise.reject(new Error('ENOTFOUND')),
  }) as unknown as Parameters<typeof pending>[1];

  it('passes records that resolve, and lists the rest', async () => {
    const r = resolver({ 'blog.example.com': ['D111.cloudfront.net.'] }, { 'example.com': ['13.224.0.1'] });
    expect(await pending([cname, alias], r)).toEqual([]);
    expect(await pending([cname, alias], resolver({}, {}))).toEqual([{ record: cname }, { record: alias }]);
  });

  it('says when a record points elsewhere, or is proxied by Cloudflare', async () => {
    const elsewhere = await pending([cname], resolver({ 'blog.example.com': ['old-host.example.net'] }, {}));
    expect(elsewhere[0]?.problem).toBe('blog.example.com points at old-host.example.net, not d111.cloudfront.net');
    const proxied = await pending([cname, alias], resolver({}, { 'blog.example.com': ['104.21.3.4'], 'example.com': ['172.67.1.2'] }));
    expect(proxied.map((p) => p.problem)).toEqual([expect.stringMatching(/proxied \(orange cloud\)/), expect.stringMatching(/DNS only \(grey cloud\)/)]);
  });
});
