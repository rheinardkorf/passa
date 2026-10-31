// Version retention against Moto: which versions and files a daily run removes.
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { NotFoundOrConflict } from '@passa/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { Publisher } from './publisher.ts';
import { applyRetention } from './retention.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
let clock: Date;
let publisher: Publisher;
const alice = { userId: 'alice' };
const page = (text: string) => [{ path: 'index.html', content: new TextEncoder().encode(`<h1>${text}</h1>`) }];

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  publisher = new Publisher({ ...env, now: () => clock });
});

// A site with one version made at each of the given times, oldest first.
async function siteWithVersions(times: string[]) {
  const [first = '', ...rest] = times;
  clock = new Date(first);
  const site = await publisher.publish(alice, { title: 'History', content: { files: page(first) } });
  const ids = [site.current_version];
  for (const at of rest) {
    clock = new Date(at);
    ids.push((await publisher.update(alice, { siteId: site.site_id, content: { files: page(at) } })).current_version);
  }
  return { siteId: site.site_id, ids };
}

const versionsOf = async (siteId: string) => (await env.store.listVersions(siteId)).map((v) => v.id).sort();
const folders = async (siteId: string) => {
  const { Contents = [] } = await env.s3.send(new ListObjectsV2Command({ Bucket: env.buckets.sites, Prefix: `${siteId}/` }));
  return [...new Set(Contents.map(({ Key = '' }) => Key.split('/')[1]))].sort();
};

describe('applyRetention', () => {
  it('keeps recent versions, month-end versions and the current one, and removes the rest with their files', async () => {
    // Oldest first: two in July, two in August, then two in the last 30 days.
    const { siteId, ids } = await siteWithVersions([
      '2026-07-05T00:00:00Z', '2026-07-25T00:00:00Z',
      '2026-08-05T00:00:00Z', '2026-08-25T00:00:00Z',
      '2026-10-10T00:00:00Z', '2026-10-20T00:00:00Z',
    ]);
    const [jul1, jul2, aug1, aug2, oct1, oct2] = ids;
    await applyRetention(env, [siteId], new Date('2026-10-31T00:00:00Z'));
    const kept = [jul2, aug2, oct1, oct2].map(String).sort();
    expect(await versionsOf(siteId)).toEqual(kept);
    expect(await folders(siteId)).toEqual(kept);
    expect(kept).not.toContain(jul1);
    expect(kept).not.toContain(aug1);

    // Events are recorded at the real time, so this test's table is scanned.
    const { Items = [] } = await env.db.send(new ScanCommand({ TableName: env.tables.events }));
    expect(Items.find((e) => e.action === 'site.retention' && e.siteId === siteId)?.detail).toBe('removed 2 old versions');
  });

  it('keeps an old version that was rolled back to', async () => {
    const { siteId, ids } = await siteWithVersions(['2026-03-05T00:00:00Z', '2026-03-10T00:00:00Z', '2026-10-20T00:00:00Z']);
    const [oldest] = ids;
    clock = new Date('2026-10-25T00:00:00Z');
    await publisher.rollback(alice, { siteId, versionId: String(oldest) });
    await applyRetention(env, [siteId], new Date('2026-10-31T00:00:00Z'));
    expect(await versionsOf(siteId)).toEqual(ids.map(String).sort());
  });

  it('leaves sites being deleted alone', async () => {
    const { siteId, ids } = await siteWithVersions(['2026-01-05T00:00:00Z', '2026-01-10T00:00:00Z', '2026-10-20T00:00:00Z']);
    await publisher.delete(alice, { siteId, now: false });
    await applyRetention(env, [siteId], new Date('2026-10-31T00:00:00Z'));
    expect(await versionsOf(siteId)).toEqual(ids.map(String).sort());
  });

  it('never removes the current version, even when asked directly', async () => {
    const { siteId, ids } = await siteWithVersions(['2026-10-20T00:00:00Z']);
    await expect(env.store.deleteVersion(siteId, String(ids[0]))).rejects.toThrow(NotFoundOrConflict);
  });

  it('gives every event a TTL of the retention period', async () => {
    await env.events.record({ action: 'test.ttl', result: 'ok' }, new Date('2026-10-31T00:00:00Z'));
    const { Items = [] } = await env.db.send(new QueryCommand({
      TableName: env.tables.events,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'DAY#2026-10-31' },
    }));
    expect(Items.find((e) => e.action === 'test.ttl')?.ttl).toBe(Date.parse('2033-10-31T00:00:00Z') / 1000);
  });
});
