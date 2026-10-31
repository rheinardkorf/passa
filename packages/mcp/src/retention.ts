// Removes old versions once a day (config.retention): every site keeps its
// versions from the last versionDays, the last version of each month for
// monthEndMonths, and its current version. A version's record goes first, so
// a rollback can never point at removed files; if removing the files then
// fails, they're left behind but never served.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { type Config, Events, NotFoundOrConflict, runtimeEnv, SiteFiles, Store, versionsToKeep } from '@passa/shared';

export type RetentionDeps = { store: Store; files: SiteFiles; events: Events; config: Config; log?: (message: string, data?: Record<string, unknown>) => void };

export async function applyRetention(deps: RetentionDeps, siteIds: string[], now: Date = new Date()): Promise<void> {
  for (const siteId of siteIds) {
    const site = await deps.store.getSite(siteId);
    // Sites being deleted are purged whole at the end of their grace period.
    if (!site || site.status === 'deleting') continue;
    const versions = await deps.store.listVersions(siteId);
    const keep = versionsToKeep(versions, site.current, now, deps.config.retention);
    const removed: string[] = [];
    for (const version of versions.filter((v) => !keep.has(v.id))) {
      try {
        await deps.store.deleteVersion(siteId, version.id);
      } catch (err) {
        if (err instanceof NotFoundOrConflict) continue; // made current again since it was read
        throw err;
      }
      removed.push(version.id);
      try {
        await deps.files.deleteVersion(siteId, version.id);
      } catch (err) {
        deps.log?.('version files not removed', { siteId, versionId: version.id, error: err instanceof Error ? err.name : String(err) });
      }
    }
    if (removed.length) {
      await deps.events.record({ action: 'site.retention', result: 'ok', siteId, userId: site.ownerId, detail: `removed ${removed.length} old version${removed.length > 1 ? 's' : ''}` });
    }
  }
}

const log = (message: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ message, ...data })); // eslint-disable-line no-console

// Every site's ID. A scan, since this is a maintenance job (see db.ts).
async function allSiteIds(db: DynamoDBDocumentClient, table: string): Promise<string[]> {
  const ids: string[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new ScanCommand({
      TableName: table,
      FilterExpression: 'begins_with(pk, :site) AND sk = :meta',
      ExpressionAttributeValues: { ':site': 'SITE#', ':meta': 'META' },
      ProjectionExpression: 'id',
      ExclusiveStartKey,
    }));
    for (const item of page.Items ?? []) if (typeof item.id === 'string') ids.push(item.id);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}

let ready: { deps: RetentionDeps; db: DynamoDBDocumentClient; table: string } | undefined;

export async function handler(): Promise<void> {
  if (!ready) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    ready = {
      db,
      table: env.tables.main,
      deps: {
        store: new Store(db, env.tables.main),
        files: new SiteFiles(new S3Client({}), env.buckets),
        events: new Events(db, env.tables.events, env.config.retention.eventYears),
        config: env.config,
        log,
      },
    };
  }
  await applyRetention(ready.deps, await allSiteIds(ready.db, ready.table));
}
