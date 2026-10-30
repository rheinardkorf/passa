// GuardDuty Malware Protection scan results with threats, from EventBridge.
// Uploads are checked again when publish uses them, so a finding there is only
// recorded. Inline publishes write straight to the sites bucket, so a finding
// there blocks the site: it stops being served and can only be deleted.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type Buckets, type EdgeRecords, Events, isSiteId, KvsEdgeStore, runtimeEnv, Store, THREATS } from '@passa/shared';
import type { EventBridgeEvent } from 'aws-lambda';

export type ScanResult = {
  s3ObjectDetails?: { bucketName?: string; objectKey?: string };
  scanResultDetails?: { scanResultStatus?: string };
};

export type ScanDeps = { store: Store; events: Events; edge: EdgeRecords; buckets: Buckets; now?: () => Date };

export async function handleScanResult(deps: ScanDeps, result: ScanResult): Promise<void> {
  const bucket = result.s3ObjectDetails?.bucketName;
  const key = result.s3ObjectDetails?.objectKey ?? '';
  if (result.scanResultDetails?.scanResultStatus !== THREATS) return;
  if (bucket === deps.buckets.uploads) {
    await deps.events.record({ action: 'upload.malware', result: 'refused', detail: key.slice(0, 300) });
    return;
  }
  if (bucket !== deps.buckets.sites) return;
  // Site files are <site-id>/<version-id>/<path>.
  const siteId = key.split('/')[0] ?? '';
  if (!isSiteId(siteId)) return;
  const site = await deps.store.getSite(siteId);
  const blocked = await deps.store.blockSite(siteId, (deps.now ?? (() => new Date()))().toISOString());
  await deps.edge.remove(siteId);
  await deps.events.record({
    action: 'site.blocked',
    result: 'ok',
    siteId,
    ...(site ? { userId: site.ownerId } : {}),
    detail: `${blocked ? 'blocked' : `was ${site?.status ?? 'missing'}`}: malware in ${key.slice(0, 300)}`,
  });
}

let deps: ScanDeps | undefined;

export async function handler(event: EventBridgeEvent<string, ScanResult>): Promise<void> {
  if (!deps) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    deps = {
      store: new Store(db, env.tables.main),
      events: new Events(db, env.tables.events),
      edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
      buckets: env.buckets,
    };
  }
  await handleScanResult(deps, event.detail);
}
