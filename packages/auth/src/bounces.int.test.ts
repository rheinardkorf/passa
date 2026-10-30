import { addUser, type TestEnv, testEnv } from '@passa/mcp/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { handleSesEvent, undeliverable } from './bounces.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await testEnv();
});

const bounce = (email: string, bounceType = 'Permanent') => ({ eventType: 'Bounce', bounce: { bounceType, bouncedRecipients: [{ emailAddress: email }] } });
const complaint = (email: string) => ({ eventType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: email }] } });

describe('SES bounces and complaints', () => {
  it('only acts on permanent bounces and complaints', () => {
    expect(undeliverable(bounce('a@example.com', 'Transient'))).toEqual([]);
    expect(undeliverable({ eventType: 'Delivery' })).toEqual([]);
    expect(undeliverable(bounce('a@example.com'))).toEqual([{ email: 'a@example.com', reason: 'bounce' }]);
    expect(undeliverable(complaint('b@example.com'))).toEqual([{ email: 'b@example.com', reason: 'complaint' }]);
  });

  it('disables a user whose address bounces', async () => {
    await addUser(env, { id: 'bounced', email: 'bounced@example.com' });
    await handleSesEvent(env, bounce('Bounced@Example.com'));
    expect((await env.store.getUser('bounced'))?.status).toBe('disabled');
  });

  it('disables a user who complains', async () => {
    await addUser(env, { id: 'complained', email: 'complained@example.com' });
    await handleSesEvent(env, complaint('complained@example.com'));
    expect((await env.store.getUser('complained'))?.status).toBe('disabled');
  });

  it('keeps admins active, so one complaint can’t lock the owners out', async () => {
    await addUser(env, { id: 'owner', email: 'owner@example.com', roles: ['admin', 'publisher'] });
    await handleSesEvent(env, complaint('owner@example.com'));
    expect((await env.store.getUser('owner'))?.status).toBe('active');
  });
});
