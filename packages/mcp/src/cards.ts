// The cards function: draws the social cards a publish had no time for (M3
// R95), invoked by the MCP function without waiting. Cards live outside
// versions, so drawing them later changes no published version.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Events, isSiteId, isVersionId, runtimeEnv, SiteFiles, Store } from '@passa/shared';
import { KvsEdgeStore } from '@passa/shared/kvs';
import { Publisher } from './publisher.ts';

export type CardsEvent = { siteId: string; versionId: string };

let publisher: Publisher | undefined;

export async function handler(event: CardsEvent): Promise<void> {
  if (!isSiteId(event.siteId) || !isVersionId(event.versionId)) return;
  if (!publisher) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    publisher = new Publisher({
      store: new Store(db, env.tables.main),
      events: new Events(db, env.tables.events, env.config.retention.eventYears),
      files: new SiteFiles(new S3Client({}), env.buckets),
      edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
      config: env.config,
    });
  }
  const result = await publisher.drawPendingCards(event.siteId, event.versionId);
  console.log(JSON.stringify({ message: 'cards drawn', siteId: event.siteId, versionId: event.versionId, ...result })); // eslint-disable-line no-console
}
