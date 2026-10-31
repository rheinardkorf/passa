// GuardDuty Malware Protection scan results with threats, from EventBridge.
// GuardDuty scans the uploads bucket only. Uploads are checked again when
// publish uses them, so a finding there is only recorded. New version files
// are staged there under inline/ and copied into place straight away, so a
// finding in one blocks the site: it stops being served and can only be deleted.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type Buckets, type EdgeRecords, Events, isSiteId, KvsEdgeStore, runtimeEnv, STAGED_PREFIX, Store, THREATS } from '@passa/shared';
import type { EventBridgeEvent } from 'aws-lambda';

export type ScanResult = {
  s3ObjectDetails?: { bucketName?: string; objectKey?: string };
  scanResultDetails?: { scanResultStatus?: string };
};

export type ScanDeps = { store: Store; events: Events; edge: EdgeRecords; buckets: Buckets; now?: () => Date };

export async function handleScanResult(deps: ScanDeps, result: ScanResult): Promise<void> {
  const bucket = result.s3ObjectDetails?.bucketName;
  const key = result.s3ObjectDetails?.objectKey ?? '';
  if (result.scanResultDetails?.scanResultStatus !== THREATS || bucket !== deps.buckets.uploads) return;
  if (!key.startsWith(STAGED_PREFIX)) {
    await deps.events.record({ action: 'upload.malware', result: 'refused', detail: key.slice(0, 300) });
    return;
  }
  // Staged files are inline/<site-id>/<version-id>/<path>.
  const file = key.slice(STAGED_PREFIX.length);
  const siteId = file.split('/')[0] ?? '';
  if (!isSiteId(siteId)) return;
  const site = await deps.store.getSite(siteId);
  const blocked = await deps.store.blockSite(siteId, (deps.now ?? (() => new Date()))().toISOString());
  await deps.edge.remove(siteId);
  await deps.events.record({
    action: 'site.blocked',
    result: 'ok',
    siteId,
    ...(site ? { userId: site.ownerId } : {}),
    detail: `${blocked ? 'blocked' : `was ${site?.status ?? 'missing'}`}: malware in ${file.slice(0, 300)}`,
  });
}

let deps: ScanDeps | undefined;

export async function handler(event: EventBridgeEvent<string, ScanResult>): Promise<void> {
  if (!deps) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    deps = {
      store: new Store(db, env.tables.main),
      events: new Events(db, env.tables.events, env.config.retention.eventYears),
      edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
      buckets: env.buckets,
    };
  }
  await handleScanResult(deps, event.detail);
}
