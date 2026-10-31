// The auth service on Lambda, behind CloudFront and WAF (a function URL).
// Only CloudFront may call it: it adds a secret origin header. CloudFront's
// viewer-request function copies the viewer's host to x-passa-host, and the
// viewer's IP comes from CloudFront-Viewer-Address, which viewers can't set.
import { timingSafeEqual } from 'node:crypto';
import { KMSClient } from '@aws-sdk/client-kms';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { configure as serverlessExpress } from '@codegenie/serverless-express';
import { bootstrapAdmins, Events, OidcStore, runtimeEnv, Store, viewerAddress } from '@passa/shared';
import type { Context, Handler } from 'aws-lambda';
import express from 'express';
import { createAuthApp } from './app.ts';
import { KmsSigningKey } from './kms-key.ts';
import { SesMailer } from './mailer.ts';
import { loadAuthSecrets } from './secrets.ts';

const log = (message: string, data?: Record<string, unknown>) => console.log(JSON.stringify({ message, ...data })); // eslint-disable-line no-console

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function build(): Promise<Handler> {
  const env = runtimeEnv();
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const kms = new KMSClient({});
  const secrets = await loadAuthSecrets(new SecretsManagerClient({}), env.authSecret);
  const [siteKey] = secrets.siteKeys;
  if (!siteKey) throw new Error('no site key');

  const store = new Store(db, env.tables.main);
  // Users from config (R30): admins get their records on start; existing
  // users keep their ID and status.
  await bootstrapAdmins(store, env.config.admins);

  const app = createAuthApp({
    store,
    events: new Events(db, env.tables.events, env.config.retention.eventYears),
    config: env.config,
    mailer: new SesMailer(new SESv2Client({}), env.config.email.from, env.configurationSet),
    siteKey: async () => siteKey,
    oidc: new OidcStore(db, env.tables.main),
    tokenSigner: await KmsSigningKey.load(kms, env.tokenKey),
    cookieKeys: secrets.cookieKeys,
    trustProxy: true,
    clientIp: (req) => viewerAddress(req.get('cloudfront-viewer-address')),
    log,
  });

  const front = express();
  front.disable('x-powered-by');
  front.use((req, res, next) => {
    if (!sameSecret(req.get('x-origin-verify') ?? '', secrets.originVerify)) {
      res.status(403).end();
      return;
    }
    req.headers['x-forwarded-host'] = req.get('x-passa-host') ?? '';
    req.headers['x-forwarded-proto'] = 'https';
    next();
  });
  front.use(app);
  return serverlessExpress({ app: front });
}

let ready: Promise<Handler> | undefined;

export async function handler(event: unknown, context: Context): Promise<unknown> {
  ready ??= build().catch((err: unknown) => {
    ready = undefined; // try again on the next request
    throw err;
  });
  return (await ready)(event, context, () => undefined);
}
