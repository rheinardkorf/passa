// Memberships (M6 R153–R155), grant dates (R158), the share audit (R165) and
// last used (R166) through the MCP tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Email } from '@passa/shared';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await addUser(env, { id: 'dan' });
});
beforeEach(() => void sent.splice(0));

type Result = { isError?: boolean; text: string; json: () => Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

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

const DAY = 86_400_000;
const files = [{ path: 'index.html', content: '<!doctype html><title>Secret course</title>x' }];
const rules = [{ path: '/lessons/', access: ['gold', 'silver'] }, { path: '/lessons/bonus/', access: ['gold'] }];
const edgeVersion = async (siteId: unknown) => (JSON.parse(await env.edge.get(`s:${String(siteId)}`)) as { v: number }).v;
const course = async (call: Awaited<ReturnType<typeof as>>) => (await call('publish', { title: 'Secret course', files, rules })).json();

describe('add_member (R153)', () => {
  it('refuses until confirmed, reading the email back', async () => {
    const call = await as('alice');
    const site = await course(call);
    const r = await call('add_member', { site_id: site.site_id, email: 'Sam@Example.com', tier: 'gold' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('sam@example.com');
    expect(r.text).toContain('confirm_member');
    expect(sent).toEqual([]);
  });

  it('adds the member, names what the tier opens, and invites without the title or tier', async () => {
    const call = await as('alice');
    const site = await course(call);
    const r = (await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'silver', confirm_member: true })).json();
    expect(r).toMatchObject({ member: { email: 'sam@example.com', tier: 'silver', last_used: 'never' }, tier_urls: [`${site.url}lessons/`], invite_sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe('alice@example.com added you as a member of a site');
    for (const part of [sent[0]?.subject, sent[0]?.text, sent[0]?.html]) {
      expect(part).not.toContain('Secret course');
      expect(part).not.toContain('silver');
      expect(part).not.toMatch(/#t=|token/i);
    }
  });

  it('says when no rule lists the tier, and refuses bad tiers and the owner', async () => {
    const call = await as('alice');
    const site = await course(call);
    expect((await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'bronze', confirm_member: true })).json().tier_note).toContain('No rule lists bronze');
    for (const tier of ['public', 'private', 'Gold', 'a b']) {
      expect((await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier, confirm_member: true })).text).toContain('A tier is 1 to 30');
    }
    expect((await call('add_member', { site_id: site.site_id, email: 'alice@example.com', tier: 'gold', confirm_member: true })).text).toContain('your own email');
  });

  it('replaces the dates when added again, invites at most hourly, and makes cookies check again', async () => {
    const t0 = new Date();
    const site = await course(await as('alice', t0));
    const add = (at: Date, extra = {}) => as('alice', at).then((call) => call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', confirm_member: true, ...extra }));
    expect((await add(t0)).json().invite_sent).toBe(true);
    const before = await edgeVersion(site.site_id);
    const end = new Date(t0.getTime() + 30 * DAY).toISOString();
    const again = (await add(new Date(t0.getTime() + 60_000), { expires_at: end })).json();
    expect(again).toMatchObject({ invite_sent: false, member: { added_at: t0.toISOString(), expires_at: end } });
    expect(await edgeVersion(site.site_id)).toBe(before + 1);
    expect(sent).toHaveLength(1);
  });

  it('counts invites against the daily cap, with shares', async () => {
    const call = await as('erin', undefined, 2);
    const site = await course(call);
    expect((await call('share', { site_id: site.site_id, email: 'a@example.com', confirm_share: true })).isError).toBe(false);
    expect((await call('add_member', { site_id: site.site_id, email: 'b@example.com', tier: 'gold', confirm_member: true })).isError).toBe(false);
    expect((await call('add_member', { site_id: site.site_id, email: 'c@example.com', tier: 'gold', confirm_member: true })).text).toContain('sent 2 invites today');
  });

  it('only works on the caller\'s own sites', async () => {
    const site = await course(await as('alice'));
    const bob = await as('bob');
    for (const [tool, args] of [['add_member', { tier: 'gold', confirm_member: true }], ['remove_member', {}], ['list_members', {}]] as const) {
      expect((await bob(tool, { site_id: site.site_id, ...(tool === 'list_members' ? {} : { email: 'sam@example.com' }), ...args })).text).toBe('No site with that ID.');
    }
  });
});

describe('dates (R158)', () => {
  it('refuses an end in the past or not after the start', async () => {
    const call = await as('alice');
    const site = await course(call);
    const now = Date.now();
    const past = new Date(now - DAY).toISOString();
    expect((await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', expires_at: past, confirm_member: true })).text).toContain('in the past');
    const r = await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', starts_at: new Date(now + 10 * DAY).toISOString(), expires_at: new Date(now + 5 * DAY).toISOString(), confirm_member: true });
    expect(r.text).toContain('after starts_at');
    expect((await call('share', { site_id: site.site_id, email: 'sam@example.com', expires_at: past, confirm_share: true })).text).toContain('in the past');
  });

  it('lets memberships last until removed, and ends shares 90 days after they begin', async () => {
    const t0 = new Date('2026-11-07T00:00:00Z');
    const call = await as('alice', t0);
    const site = await course(call);
    expect((await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', confirm_member: true })).json().member.expires_at).toBeUndefined();
    expect((await call('share', { site_id: site.site_id, email: 'sam@example.com', path: '/lessons/', confirm_share: true })).json().share.expires_at).toBe('2027-02-05T00:00:00.000Z');
    const later = (await call('share', { site_id: site.site_id, email: 'kim@example.com', path: '/lessons/', starts_at: '2026-12-01T00:00:00Z', confirm_share: true })).json();
    expect(later.share).toMatchObject({ starts_at: '2026-12-01T00:00:00.000Z', expires_at: '2027-03-01T00:00:00.000Z' });
    expect(sent.at(-1)?.text).toContain('from 2026-12-01 until 2027-03-01');
    // Starting far ahead, the default end stops at a year.
    const far = (await call('share', { site_id: site.site_id, email: 'lee@example.com', path: '/lessons/', starts_at: '2027-10-01T00:00:00Z', confirm_share: true })).json();
    expect(Date.parse(far.share.expires_at)).toBeLessThanOrEqual(t0.getTime() + 366 * DAY);
  });

  it('leaves ended memberships out of the list, and lists ones that haven\'t begun', async () => {
    const t0 = new Date();
    const site = await course(await as('alice', t0));
    const add = async (email: string, extra: Record<string, string>) => (await as('alice', t0))('add_member', { site_id: site.site_id, email, tier: 'gold', confirm_member: true, ...extra });
    await add('ends@example.com', { expires_at: new Date(t0.getTime() + 2 * 3_600_000).toISOString() });
    await add('later@example.com', { starts_at: new Date(t0.getTime() + 10 * DAY).toISOString() });
    const listed = (await (await as('alice', new Date(t0.getTime() + 3 * 3_600_000)))('list_members', { site_id: site.site_id })).json();
    expect(listed.members.map((m: { email: string }) => m.email)).toEqual(['later@example.com']);
  });
});

describe('remove_member and list_members (R154, R155)', () => {
  it('lists by email or tier a page at a time, and removing bumps the access version', async () => {
    const call = await as('alice');
    const site = await course(call);
    for (const [email, tier] of [['a@example.com', 'gold'], ['b@example.com', 'silver'], ['c@example.com', 'gold'], ['a@example.com', 'silver']]) {
      await call('add_member', { site_id: site.site_id, email, tier, confirm_member: true });
    }
    const all = (await call('list_members', { site_id: site.site_id })).json();
    expect(all.tiers).toEqual(['gold', 'silver']);
    expect(all.members.map((m: { email: string; tier: string }) => `${m.email} ${m.tier}`)).toEqual(['a@example.com gold', 'a@example.com silver', 'b@example.com silver', 'c@example.com gold']);

    const first = (await call('list_members', { site_id: site.site_id, tier: 'gold', limit: 1 })).json();
    expect(first.members.map((m: { email: string }) => m.email)).toEqual(['a@example.com']);
    const second = (await call('list_members', { site_id: site.site_id, tier: 'gold', limit: 1, cursor: first.next_cursor })).json();
    expect(second.members.map((m: { email: string }) => m.email)).toEqual(['c@example.com']);
    expect((await call('list_members', { site_id: site.site_id, cursor: 'bm90LWEtY3Vyc29y' })).text).toContain('cursor isn\'t one Passa returned');

    const before = await edgeVersion(site.site_id);
    expect((await call('remove_member', { site_id: site.site_id, email: 'A@example.com', tier: 'gold' })).json()).toMatchObject({ removed: 1, tier: 'gold' });
    expect(await edgeVersion(site.site_id)).toBe(before + 1);
    expect((await call('remove_member', { site_id: site.site_id, email: 'a@example.com' })).json()).toMatchObject({ removed: 1 });
    expect((await call('remove_member', { site_id: site.site_id, email: 'a@example.com' })).text).toContain('isn\'t a member');
    expect((await call('list_members', { site_id: site.site_id })).json().members.map((m: { email: string }) => m.email)).toEqual(['b@example.com', 'c@example.com']);
  });
});

describe('list_shares (R165) and last used (R166)', () => {
  it('lists every share across the caller\'s sites, soonest end first, narrowed by end or site', async () => {
    const t0 = new Date();
    const call = await as('bob', t0);
    const one = await course(call);
    const two = await course(call);
    const at = (days: number) => new Date(t0.getTime() + days * DAY).toISOString();
    await call('share', { site_id: one.site_id, email: 'late@example.com', expires_at: at(200), confirm_share: true });
    await call('share', { site_id: two.site_id, email: 'soon@example.com', path: '/lessons/', expires_at: at(10), confirm_share: true });
    await call('share', { site_id: one.site_id, email: 'mid@example.com', confirm_share: true });
    // Another owner's shares aren't listed.
    await (await as('alice'))('share', { site_id: (await course(await as('alice'))).site_id, email: 'other@example.com', confirm_share: true });

    const all = (await call('list_shares', {})).json();
    expect(all.shares.map((s: { email: string }) => s.email)).toEqual(['soon@example.com', 'mid@example.com', 'late@example.com']);
    expect(all.shares[0]).toMatchObject({ site_id: two.site_id, url: `${two.url}lessons/`, path: '/lessons/', last_used: 'never' });
    expect((await call('list_shares', { ending_within_days: 30 })).json().shares.map((s: { email: string }) => s.email)).toEqual(['soon@example.com']);
    expect((await call('list_shares', { site_id: one.site_id })).json().shares.map((s: { email: string }) => s.email)).toEqual(['mid@example.com', 'late@example.com']);

    const paged = (await call('list_shares', { limit: 2 })).json();
    expect(paged.shares).toHaveLength(2);
    expect((await call('list_shares', { limit: 2, cursor: paged.next_cursor })).json().shares.map((s: { email: string }) => s.email)).toEqual(['late@example.com']);
  });

  it('moves a renewed share along, and drops unshared ones', async () => {
    const t0 = new Date();
    const call = await as('dan', t0);
    const site = await course(call);
    await call('share', { site_id: site.site_id, email: 'x@example.com', expires_at: new Date(t0.getTime() + 5 * DAY).toISOString(), confirm_share: true });
    await call('share', { site_id: site.site_id, email: 'y@example.com', expires_at: new Date(t0.getTime() + 20 * DAY).toISOString(), confirm_share: true });
    await call('share', { site_id: site.site_id, email: 'x@example.com', expires_at: new Date(t0.getTime() + 40 * DAY).toISOString(), confirm_share: true });
    expect((await call('list_shares', {})).json().shares.map((s: { email: string }) => s.email)).toEqual(['y@example.com', 'x@example.com']);
    await call('unshare', { site_id: site.site_id, email: 'y@example.com' });
    expect((await call('list_shares', {})).json().shares.map((s: { email: string }) => s.email)).toEqual(['x@example.com']);
  });

  it('shows when a grant was last used, and keeps it when the grant is renewed', async () => {
    const call = await as('alice');
    const site = await course(call);
    await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', confirm_member: true });
    await call('share', { site_id: site.site_id, email: 'sam@example.com', path: '/lessons/', confirm_share: true });
    await env.store.markUsed({ kind: 'member', siteId: site.site_id, email: 'sam@example.com', tier: 'gold' }, '2026-11-01');
    await env.store.markUsed({ kind: 'share', siteId: site.site_id, email: 'sam@example.com', path: '/lessons/' }, '2026-11-02');
    // Marking a removed grant writes nothing back.
    await env.store.markUsed({ kind: 'member', siteId: site.site_id, email: 'gone@example.com', tier: 'gold' }, '2026-11-02');
    expect(await env.store.getMembership(site.site_id, 'gone@example.com', 'gold')).toBeUndefined();

    await call('add_member', { site_id: site.site_id, email: 'sam@example.com', tier: 'gold', confirm_member: true });
    expect((await call('list_members', { site_id: site.site_id })).json().members[0].last_used).toBe('2026-11-01');
    expect((await call('list_access', { site_id: site.site_id })).json()).toMatchObject({ tiers: ['gold', 'silver'], shares: [{ last_used: '2026-11-02' }] });
  });
});
