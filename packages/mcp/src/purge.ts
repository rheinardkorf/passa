// Hard deletes at the end of the grace period. Deleting a site writes a PURGE
// item whose TTL is the purge time; when DynamoDB expires it, the table stream
// delivers the removed item here (filtered to TTL removals of PURGE and NAME
// items). A site that's no longer being deleted is left alone. An expired
// held name (M2 R46) has its edge record removed, unless it's been claimed again.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Events, KvsEdgeStore, runtimeEnv, SiteFiles, Store } from '@passa/shared';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { type Deps, Publisher } from './publisher.ts';

export async function purgeExpired(deps: Deps, siteIds: string[]): Promise<void> {
  const publisher = new Publisher(deps);
  for (const siteId of siteIds) {
    const site = await deps.store.getSite(siteId);
    if (site && site.status !== 'deleting') continue;
    await publisher.purge(siteId);
    await deps.events.record({ action: 'site.purge', result: 'ok', siteId, ...(site ? { userId: site.ownerId } : {}) });
  }
}

// The items of one kind in a batch of stream records: only TTL removals.
function expired(event: DynamoDBStreamEvent, prefix: string, field: string): string[] {
  return event.Records.flatMap((record) => {
    const image = record.dynamodb?.OldImage;
    const ttlRemoval = record.eventName === 'REMOVE' && record.userIdentity?.principalId === 'dynamodb.amazonaws.com';
    const value = image?.[field]?.S;
    return ttlRemoval && image?.pk?.S?.startsWith(prefix) && value ? [value] : [];
  });
}

export const expiredPurges = (event: DynamoDBStreamEvent): string[] => expired(event, 'PURGE#', 'siteId');
export const expiredNames = (event: DynamoDBStreamEvent): string[] => expired(event, 'NAME#', 'name');

let deps: Deps | undefined;

export async function handler(event: DynamoDBStreamEvent): Promise<void> {
  if (!deps) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    deps = {
      store: new Store(db, env.tables.main),
      events: new Events(db, env.tables.events),
      files: new SiteFiles(new S3Client({}), env.buckets),
      edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
      config: env.config,
    };
  }
  await purgeExpired(deps, expiredPurges(event));
  const publisher = new Publisher(deps);
  for (const name of expiredNames(event)) await publisher.expireName(name);
}
