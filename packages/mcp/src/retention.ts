// Removes old versions once a day (config.retention): every site keeps its
// versions from the last versionDays, the last version of each month for
// monthEndMonths, and its current version. A version's record goes first, so
// a rollback can never point at removed files; if removing the files then
// fails, they're left behind but never served.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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

// Every site's ID, through the indexes rather than a scan: every user (gsi2),
// then each one's sites (gsi1). Only publishers have sites.
export async function allSiteIds(store: Store): Promise<string[]> {
  const ids: string[] = [];
  for (const user of await store.listUsers()) {
    if (user.roles.length) for (const site of await store.listSitesByOwner(user.id)) ids.push(site.id);
  }
  return ids;
}

let ready: RetentionDeps | undefined;

export async function handler(): Promise<void> {
  if (!ready) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    ready = {
      store: new Store(db, env.tables.main),
      files: new SiteFiles(new S3Client({}), env.buckets),
      events: new Events(db, env.tables.events, env.config.retention.eventYears),
      config: env.config,
      log,
    };
  }
  await applyRetention(ready, await allSiteIds(ready.store));
}
