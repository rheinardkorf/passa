import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';
import { Publisher } from './publisher.ts';
import { expiredPurges, purgeExpired } from './purge.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
});

const files = [{ path: 'index.html', content: new TextEncoder().encode('<h1>hi</h1>') }];

const removal = (siteId: string, ttl: boolean) => ({
  eventName: 'REMOVE',
  userIdentity: ttl ? { type: 'Service', principalId: 'dynamodb.amazonaws.com' } : undefined,
  dynamodb: { OldImage: { pk: { S: `PURGE#${siteId}` }, sk: { S: 'META' }, siteId: { S: siteId } } },
});

describe('purge at the end of the grace period', () => {
  it('only acts on TTL removals of PURGE items', () => {
    const event = { Records: [removal('a', true), removal('b', false), { eventName: 'REMOVE', userIdentity: { principalId: 'dynamodb.amazonaws.com' }, dynamodb: { OldImage: { pk: { S: 'TOKEN#x' } } } }] };
    expect(expiredPurges(event as unknown as DynamoDBStreamEvent)).toEqual(['a']);
  });

  it('removes a deleted site’s records, files and edge record', async () => {
    const publisher = new Publisher(env);
    const site = await publisher.publish({ userId: 'alice' }, { title: 'Gone', content: { files } });
    await publisher.delete({ userId: 'alice' }, { siteId: site.site_id, now: false });

    await purgeExpired(env, [site.site_id]);

    expect(await env.store.getSite(site.site_id)).toBeUndefined();
    expect(await env.store.listVersions(site.site_id)).toEqual([]);
    await expect(env.edge.get(`s:${site.site_id}`)).rejects.toThrow();
    const left = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.sites, Prefix: `${site.site_id}/` }));
    expect(left.KeyCount).toBe(0);
  });

  it('leaves a site alone if it is active again', async () => {
    const publisher = new Publisher(env);
    const site = await publisher.publish({ userId: 'alice' }, { title: 'Kept', content: { files } });
    await purgeExpired(env, [site.site_id]);
    expect((await env.store.getSite(site.site_id))?.status).toBe('active');
    expect(JSON.parse(await env.edge.get(`s:${site.site_id}`)).cur).toBeTruthy();
  });
});
