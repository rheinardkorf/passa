// passa admin users (M5 R143) against the real store: adding publishers,
// disabling and enabling them, and the guards that keep a deployment runnable.
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { Publisher } from '@passa/mcp';
import { addUser, type TestEnv, testEnv } from '@passa/mcp/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminUsers } from './users.ts';

let env: TestEnv;
let users: AdminUsers;

beforeAll(async () => {
  env = await testEnv();
  // admin@example.com is the test config's admin.
  await addUser(env, { id: 'boss', email: 'admin@example.com', roles: ['admin', 'publisher'] });
  users = new AdminUsers({ store: env.store, events: env.events, config: env.config });
});

describe('admin users (R143)', () => {
  it('adds a publisher, who can then use MCP, and refuses adding them twice', async () => {
    const added = await users.add({ email: ' New@Example.com ', actor: 'me@laptop' });
    expect(added).toMatchObject({ email: 'new@example.com', roles: ['publisher'], status: 'active', in_config: false });
    const user = await env.store.findUserByEmail('new@example.com');
    await expect(new Publisher(env).assertPublisher({ userId: user?.id ?? '' })).resolves.toBeUndefined();
    await expect(users.add({ email: 'new@example.com' })).rejects.toThrow('already a publisher');
    await expect(users.add({ email: 'not-an-email' })).rejects.toThrow('isn\'t an email address');
  });

  it('gives someone a site was shared with the publisher role, keeping their record', async () => {
    const viewer = await addUser(env, { id: 'viewer', email: 'viewer@example.com', roles: [] });
    expect(await users.add({ email: 'viewer@example.com', admin: true })).toMatchObject({ roles: ['admin', 'publisher'] });
    expect((await env.store.findUserByEmail('viewer@example.com'))?.id).toBe(viewer.id);
  });

  it('disables a publisher, refused by MCP from the next call, and enables them again', async () => {
    const { id } = await addUser(env, { id: 'pub', email: 'pub@example.com' });
    expect(await users.disable({ email: 'pub@example.com', actor: 'me@laptop' })).toMatchObject({ status: 'disabled' });
    await expect(new Publisher(env).assertPublisher({ userId: id })).rejects.toThrow('This account cannot publish.');
    await expect(users.add({ email: 'pub@example.com' })).rejects.toThrow('disabled: enable them instead');
    expect(await users.enable({ email: 'pub@example.com' })).toMatchObject({ status: 'active' });
    await expect(new Publisher(env).assertPublisher({ userId: id })).resolves.toBeUndefined();
  });

  it('never disables an admin in config, or the last active admin', async () => {
    await expect(users.disable({ email: 'admin@example.com' })).rejects.toThrow('is an admin in config');
    const local = new AdminUsers({ store: env.store, events: env.events, config: { ...env.config, admins: ['someone-else@example.com'] } });
    // viewer@example.com was made an admin above; with both active, one can go.
    expect(await local.disable({ email: 'viewer@example.com' })).toMatchObject({ status: 'disabled' });
    await expect(local.disable({ email: 'admin@example.com' })).rejects.toThrow('the last active admin');
    await expect(users.disable({ email: 'nobody@example.com' })).rejects.toThrow('There\'s no user');
  });

  it('lists every user, marking admins from config', async () => {
    const list = await users.list();
    expect(list.find((u) => u.email === 'admin@example.com')).toMatchObject({ roles: ['admin', 'publisher'], in_config: true });
    expect(list.map((u) => u.email)).toEqual([...list.map((u) => u.email)].sort());
    expect(list.map((u) => u.email)).toContain('pub@example.com');
  });

  it('lists users written before the users index once reindexed (a one-off)', async () => {
    const old = { id: 'old', email: 'old@example.com', roles: ['publisher'], status: 'active', createdAt: '2026-10-30T00:00:00.000Z' };
    await env.db.send(new PutCommand({ TableName: env.tables.main, Item: { pk: 'USER#old', sk: 'PROFILE', gsi1pk: 'EMAIL#old@example.com', gsi1sk: 'USER', ...old } }));
    expect((await users.list()).map((u) => u.email)).not.toContain('old@example.com');
    expect(await users.reindex()).toEqual({ reindexed: 1 });
    expect((await users.list()).find((u) => u.email === 'old@example.com')).toMatchObject({ roles: ['publisher'], status: 'active' });
    expect(await users.reindex()).toEqual({ reindexed: 0 });
  });
});
