// The admin function (M4 R113): invoked directly with AWS credentials by
// passa admin, never through MCP or a URL. Being allowed to invoke it is what
// makes someone an admin. Each call does one step of one action and returns
// a report; the CLI calls again until the domain is live or gone.
import { ACMClient } from '@aws-sdk/client-acm';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Route53Client } from '@aws-sdk/client-route-53';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Publisher } from '@passa/mcp';
import { ENV, Events, runtimeEnv, SiteFiles, Store, type TenantChoice } from '@passa/shared';
import { KvsEdgeStore } from '@passa/shared/kvs';
import { CloudFrontDomains } from './cloudfront.ts';
import { ManualDns, Route53Dns } from './dns.ts';
import { AdminDomains, DomainRefused } from './domains.ts';

export type AdminEvent =
  | { action: 'domain.add'; domain: string; site: string; tenant: TenantChoice; primary?: boolean; actor?: string }
  | { action: 'domain.remove'; domain: string; actor?: string }
  | { action: 'domain.status'; domain: string }
  | { action: 'domain.list' };

export type AdminResult = { ok: true; result: unknown } | { ok: false; refused: string };

const log = (message: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ message, ...data })); // eslint-disable-line no-console

function build(): AdminDomains {
  const env = runtimeEnv();
  const get = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const store = new Store(db, env.tables.main);
  const events = new Events(db, env.tables.events, env.config.retention.eventYears);
  const lambda = new LambdaClient({});
  const publisher = new Publisher({
    store, events, config: env.config,
    files: new SiteFiles(new S3Client({}), env.buckets),
    edge: new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), env.edgeStore),
    malwareScan: env.malwareScan,
    ...(env.cardsFunction ? {
      drawCardsLater: async (siteId: string, versionId: string) => {
        await lambda.send(new InvokeCommand({ FunctionName: env.cardsFunction, InvocationType: 'Event', Payload: JSON.stringify({ siteId, versionId }) }));
      },
    } : {}),
  });
  return new AdminDomains({
    store, events, config: env.config, publisher,
    // CloudFront and ACM certificates for CloudFront live in us-east-1.
    // The distribution is this stage's own, so the prefix only marks Passa's tenants.
    provider: new CloudFrontDomains(new CloudFrontClient({ region: 'us-east-1' }), new ACMClient({ region: 'us-east-1' }), {
      distributionId: get(ENV.domainsDistribution), connectionGroupId: get(ENV.domainsConnectionGroup),
      prefix: 'passa', namesPerTenant: env.config.domains.namesPerTenant,
    }),
    dns: new Route53Dns(new Route53Client({}), env.config.domains.zones),
    manual: new ManualDns(),
  });
}

let admin: AdminDomains | undefined;

export async function handler(event: AdminEvent): Promise<AdminResult> {
  admin ??= build();
  try {
    switch (event.action) {
      case 'domain.add': return { ok: true, result: await admin.add(event) };
      case 'domain.remove': return { ok: true, result: await admin.remove(event) };
      case 'domain.status': return { ok: true, result: await admin.status(event.domain) };
      case 'domain.list': return { ok: true, result: await admin.list() };
      default: return { ok: false, refused: `Unknown action ${(event as { action?: unknown }).action as string}` };
    }
  } catch (err) {
    if (err instanceof DomainRefused) return { ok: false, refused: err.message };
    log('admin action failed', { action: event.action, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    throw err;
  }
}
