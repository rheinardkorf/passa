// Sharing (M5 R128–R134, R138) through the MCP tools: grants, the rules share
// changes, invites and their limits, and revocation through the access version.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Email } from '@passa/shared';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expiredShares } from './purge.ts';
import { Publisher } from './publisher.ts';
import { createServer } from './server.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
const sent: Email[] = [];
const mailer = { kind: 'memory', send: async (email: Email) => void sent.push(email) };

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  await addUser(env, { id: 'bob' });
  await addUser(env, { id: 'erin' });
});
beforeEach(() => void sent.splice(0));

type Result = { isError?: boolean; text: string; json: () => Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

// Invites are unlimited here, except in the test of their limit.
async function as(userId: string, now?: Date, invitesPerDay = 1000) {
  const config = { ...env.config, rateLimits: { ...env.config.rateLimits, invitesPerDay } };
  const server = createServer({ ...env, config, mailer, ...(now ? { now: () => now } : {}) }, { userId }, () => undefined);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return async (name: string, args: Record<string, unknown>): Promise<Result> => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
}

const page = (body: string) => [{ path: 'index.html', content: `<!doctype html><title>Secret plans</title>${body}` }];
const edgeRecord = async (siteId: unknown) => JSON.parse(await env.edge.get(`s:${String(siteId)}`));

describe('share (R128–R130)', () => {
  it('refuses until confirmed, reading the email back', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Secret plans', files: page('x') })).json();
    const r = await call('share', { site_id: site.site_id, email: 'Sam@Example.com' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('sam@example.com');
    expect(r.text).toContain('confirm_share');
    expect((await call('list_access', { site_id: site.site_id })).json().shares).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('makes a private path shared, stores the share and sends an invite without the title', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Secret plans', files: page('x') })).json();
    const r = await call('share', { site_id: site.site_id, email: 'sam@example.com', path: '/plans/', confirm_share: true });
    expect(r.isError).toBe(false);
    expect(r.json()).toMatchObject({ made_shared: ['/plans/'], made_public: [], invite_sent: true, access: 'mixed', share: { email: 'sam@example.com' } });
    expect(r.json().rules).toEqual([{ path: '/plans/', tier: 'shared' }]);
    expect(r.json().shared_urls).toEqual([`${site.url}plans/`]);
    expect((await edgeRecord(site.site_id)).r).toEqual([['/plans/', 's']]);

    expect(sent).toHaveLength(1);
    const [invite] = sent;
    expect(invite?.to).toBe('sam@example.com');
    expect(invite?.subject).toBe('alice@example.com shared a site with you');
    expect(invite?.text).toContain(`${site.url}plans/`);
    for (const part of [invite?.subject, invite?.text, invite?.html]) {
      expect(part).not.toContain('Secret plans');
      expect(part).not.toMatch(/#t=|token/i);
    }
  });

  it('says which other shared paths a share opens, including a shared folder above it', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Two audiences', files: page('x') })).json();
    const first = (await call('share', { site_id: site.site_id, email: 'sam@example.com', path: '/plans/', confirm_share: true })).json();
    expect(first.also_opens).toBeUndefined();
    const second = (await call('share', { site_id: site.site_id, email: 'kim@example.com', path: '/reports/', confirm_share: true })).json();
    expect(second.also_opens).toEqual([`${site.url}plans/`]);
    expect(second.share_note).toContain('kim@example.com can also open');

    const whole = (await call('publish', { title: 'All shared', files: page('x'), rules: [{ path: '/', tier: 'shared' }] })).json();
    const under = (await call('share', { site_id: whole.site_id, email: 'sam@example.com', path: '/plans/', confirm_share: true })).json();
    expect(under).toMatchObject({ made_shared: [], also_opens: [whole.url] });
  });

  it('leaves shared and public paths as they are, and never needs confirm_public', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Open', files: page('x'), rules: [{ path: '/', tier: 'public' }], confirm_public: true })).json();
    const r = (await call('share', { site_id: site.site_id, email: 'sam@example.com', confirm_share: true })).json();
    expect(r).toMatchObject({ made_shared: [], access: 'public', rules: [{ path: '/', tier: 'public' }] });
  });

  it('switches private and shared with set_access without confirm_public (R138)', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Tiers', files: page('x') })).json();
    const shared = (await call('set_access', { site_id: site.site_id, rules: [{ path: '/', tier: 'shared' }] })).json();
    expect(shared).toMatchObject({ access: 'shared', made_shared: ['/'] });
    const back = (await call('set_access', { site_id: site.site_id, rules: [] })).json();
    expect(back).toMatchObject({ access: 'private', made_private: ['/'] });
    expect(back.note).toContain('up to a minute');
  });

  it('resends at most hourly, and keeps when it was first shared', async () => {
    const t0 = new Date();
    const site = (await (await as('alice', t0))('publish', { title: 'Resend', files: page('x') })).json();
    const share = (at: Date, extra = {}) => as('alice', at).then((call) => call('share', { site_id: site.site_id, email: 'sam@example.com', confirm_share: true, ...extra }));
    expect((await share(t0)).json().invite_sent).toBe(true);
    const again = (await share(new Date(t0.getTime() + 10 * 60_000))).json();
    expect(again).toMatchObject({ invite_sent: false, invite_note: expect.stringContaining('less than an hour ago') });
    const later = (await share(new Date(t0.getTime() + 61 * 60_000))).json();
    expect(later.invite_sent).toBe(true);
    expect(later.share.shared_at).toBe(t0.toISOString());
    expect(sent).toHaveLength(2);
  });

  it('refuses the owner\'s own email, and expiries out of range', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Expiry', files: page('x') })).json();
    expect((await call('share', { site_id: site.site_id, email: 'alice@example.com', confirm_share: true })).text).toContain('your own email');
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const far = new Date(Date.now() + 400 * 86_400_000).toISOString();
    for (const at of [soon, far]) {
      expect((await call('share', { site_id: site.site_id, email: 'sam@example.com', expires_at: at, confirm_share: true })).text).toContain('at least an hour and at most a year');
    }
    const ok = (await call('share', { site_id: site.site_id, email: 'sam@example.com', expires_at: '2027-01-31T00:00:00Z', confirm_share: true })).json();
    expect(ok.share.expires_at).toBe('2027-01-31T00:00:00.000Z');
    expect(sent.at(-1)?.text).toContain('until 2027-01-31');
  });

  it('only shares the caller\'s own sites', async () => {
    const site = (await (await as('alice'))('publish', { title: 'Mine', files: page('x') })).json();
    const bob = await as('bob');
    expect((await bob('share', { site_id: site.site_id, email: 'sam@example.com', confirm_share: true })).text).toBe('No site with that ID.');
    expect((await bob('list_access', { site_id: site.site_id })).text).toBe('No site with that ID.');
    expect((await bob('unshare', { site_id: site.site_id, email: 'sam@example.com' })).text).toBe('No site with that ID.');
  });
});

describe('limits (R134)', () => {
  it('shares a site with at most sharesPerSite emails, counting a re-share once', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Many', files: page('x') })).json();
    for (const n of [1, 2, 3]) expect((await call('share', { site_id: site.site_id, email: `p${n}@example.com`, confirm_share: true })).isError).toBe(false);
    expect((await call('share', { site_id: site.site_id, email: 'p4@example.com', confirm_share: true })).text).toContain('shared with 3 emails, the most allowed');
    expect((await call('share', { site_id: site.site_id, email: 'p1@example.com', confirm_share: true })).isError).toBe(false);
  });

  it('sends at most invitesPerDay invites per publisher', async () => {
    const call = await as('erin', undefined, env.config.rateLimits.invitesPerDay);
    const sites = await Promise.all([1, 2].map((n) => call('publish', { title: `Site ${n}`, files: page('x') }).then((r) => r.json().site_id)));
    const results = [];
    for (const n of [1, 2, 3, 4, 5, 6]) results.push(await call('share', { site_id: sites[n % 2], email: `q${n}@example.com`, confirm_share: true }));
    expect(results.slice(0, 5).every((r) => !r.isError)).toBe(true);
    expect(results[5]?.text).toContain('sent 5 invites today');
    expect(sent).toHaveLength(5);
  });
});

describe('list_access and unshare (R131, R132)', () => {
  it('lists the shares, and unsharing bumps the access version but keeps the rules', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Revoke', files: page('x') })).json();
    await call('share', { site_id: site.site_id, email: 'sam@example.com', path: '/plans/', confirm_share: true });
    await call('share', { site_id: site.site_id, email: 'kim@example.com', path: '/plans/', confirm_share: true });
    const listed = (await call('list_access', { site_id: site.site_id })).json();
    expect(listed.shares.map((s: { email: string }) => s.email).sort()).toEqual(['kim@example.com', 'sam@example.com']);
    expect(listed.shares[0]).toMatchObject({ shared_at: expect.any(String), invited_at: expect.any(String) });
    expect(listed.shared_urls).toEqual([`${site.url}plans/`]);

    const before = (await edgeRecord(site.site_id)).v;
    expect((await call('unshare', { site_id: site.site_id, email: 'Sam@example.com' })).json()).toMatchObject({ unshared: true, email: 'sam@example.com' });
    expect((await edgeRecord(site.site_id)).v).toBe(before + 1);
    const after = (await call('list_access', { site_id: site.site_id })).json();
    expect(after.shares.map((s: { email: string }) => s.email)).toEqual(['kim@example.com']);
    expect(after.rules).toEqual([{ path: '/plans/', tier: 'shared' }]);
    expect((await call('unshare', { site_id: site.site_id, email: 'sam@example.com' })).text).toContain('isn\'t shared with that email');
  });

  it('leaves out expired shares', async () => {
    const t0 = new Date();
    const site = (await (await as('alice', t0))('publish', { title: 'Expired', files: page('x') })).json();
    await (await as('alice', t0))('share', { site_id: site.site_id, email: 'sam@example.com', expires_at: new Date(t0.getTime() + 2 * 3_600_000).toISOString(), confirm_share: true });
    expect((await (await as('alice', t0))('list_access', { site_id: site.site_id })).json().shares).toHaveLength(1);
    expect((await (await as('alice', new Date(t0.getTime() + 3 * 3_600_000)))('list_access', { site_id: site.site_id })).json().shares).toEqual([]);
  });
});

describe('expiry (R133)', () => {
  const removal = (pk: string, sk: string, siteId: string, byTtl = true) => ({
    eventName: 'REMOVE',
    ...(byTtl ? { userIdentity: { type: 'Service', principalId: 'dynamodb.amazonaws.com' } } : {}),
    dynamodb: { OldImage: { pk: { S: pk }, sk: { S: sk }, siteId: { S: siteId } } },
  });

  it('finds the sites of shares DynamoDB removed, once each', () => {
    const event = { Records: [
      removal('SITE#a', 'GRANT#x@example.com', 'a'), removal('SITE#a', 'GRANT#y@example.com', 'a'),
      removal('SITE#b', 'GRANT#x@example.com', 'b', false), removal('SITE#c', 'SITE', 'c'),
    ] } as unknown as DynamoDBStreamEvent;
    expect(expiredShares(event)).toEqual(['a']);
  });

  it('bumps the access version when a share expires', async () => {
    const call = await as('alice');
    const site = (await call('publish', { title: 'Expires', files: page('x'), rules: [{ path: '/', tier: 'shared' }] })).json();
    const before = (await edgeRecord(site.site_id)).v;
    await new Publisher(env).expireShare(site.site_id);
    expect((await edgeRecord(site.site_id)).v).toBe(before + 1);
  });
});
