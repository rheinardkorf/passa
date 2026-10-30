// Test wiring against Moto (see compose.yaml). Each call gets its own tables
// and buckets, so test files can run in parallel against one Moto.
import { randomBytes } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { type Config, createTables, Events, SiteFiles, Store, TableEdgeStore, type User } from '@passa/shared';
import type { Deps } from '../publisher.ts';

const endpoint = process.env.PASSA_TEST_AWS_ENDPOINT ?? 'http://127.0.0.1:5005';
const aws = { endpoint, region: 'ap-southeast-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };

export const testConfig: Config = {
  domain: 'example.com',
  region: 'ap-southeast-2',
  accounts: { dev: '000000000000', prod: '111111111111' },
  admins: ['admin@example.com'],
  email: { from: 'Passa <no-reply@example.com>' },
  lifetimes: { accessToken: 3600, refreshToken: 2592000, siteCookie: 3600, sessionIdle: 604800, sessionMax: 2592000, magicLink: 900, uploadUrl: 900 },
  limits: { inlinePublish: 64 * 1024, site: 256 * 1024, file: 128 * 1024, files: 20 },
  rateLimits: { window: 3600, signinPerEmail: 3, signinPerIp: 100, authPerIp: 600, authFormsPerIp: 30, mcpPerSecond: 20, mcpBurst: 40 },
  deleteGraceDays: 7,
  nameHoldDays: 7,
  reservedNames: ['blog'],
  cdnAllowlist: ['cdn.jsdelivr.net'],
};

export type TestEnv = Deps & {
  db: DynamoDBDocumentClient;
  s3: S3Client;
  edge: TableEdgeStore;
  tables: { main: string; events: string; edge: string };
  buckets: { sites: string; uploads: string };
};

export async function testEnv(config: Config = testConfig): Promise<TestEnv> {
  const id = randomBytes(4).toString('hex');
  const tables = { main: `passa-${id}`, events: `passa-events-${id}`, edge: `passa-edge-${id}` };
  const buckets = { sites: `passa-sites-${id}`, uploads: `passa-uploads-${id}` };
  const client = new DynamoDBClient(aws);
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({ ...aws, forcePathStyle: true });
  await createTables(client, tables);
  for (const Bucket of Object.values(buckets)) {
    await s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: 'ap-southeast-2' } }));
  }
  return {
    db,
    s3,
    tables,
    buckets,
    config,
    store: new Store(db, tables.main),
    files: new SiteFiles(s3, buckets),
    events: new Events(db, tables.events),
    edge: new TableEdgeStore(db, tables.edge),
  };
}

export async function addUser(env: TestEnv, user: Partial<User> & { id: string }): Promise<User> {
  const full: User = { email: `${user.id}@example.com`, roles: ['publisher'], status: 'active', createdAt: new Date().toISOString(), ...user };
  await env.store.putUser(full);
  return full;
}
