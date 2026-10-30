// The MCP server on Lambda, behind an API Gateway HTTP API on mcp.<domain>.
// The caller's IP comes from API Gateway's request context, not a header.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { KMSClient } from '@aws-sdk/client-kms';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { configure as serverlessExpress, getCurrentInvoke } from '@codegenie/serverless-express';
import { Events, KvsEdgeStore, loadTokenKey, OidcStore, runtimeEnv, SiteFiles, Store } from '@passa/shared';
import type { APIGatewayProxyEventV2, Context, Handler } from 'aws-lambda';
import { createMcpApp } from './http.ts';

const log = (message: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ message, ...data })); // eslint-disable-line no-console

async function build(): Promise<Handler> {
  const env = runtimeEnv();
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const app = createMcpApp({
    store: new Store(db, env.tables.main),
    events: new Events(db, env.tables.events),
    files: new SiteFiles(new S3Client({}), env.buckets),
    edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
    config: env.config,
    oidc: new OidcStore(db, env.tables.main),
    tokenKeys: [await loadTokenKey(new KMSClient({}), env.tokenKey)],
    issuer: `https://auth.${env.config.domain}`,
    resource: `https://mcp.${env.config.domain}/mcp`,
    clientIp: () => (getCurrentInvoke().event as APIGatewayProxyEventV2 | undefined)?.requestContext.http.sourceIp ?? '',
    log,
  });
  app.disable('x-powered-by');
  return serverlessExpress({ app });
}

let ready: Promise<Handler> | undefined;

export async function handler(event: unknown, context: Context): Promise<unknown> {
  ready ??= build().catch((err: unknown) => {
    ready = undefined; // try again on the next request
    throw err;
  });
  return (await ready)(event, context, () => undefined);
}
