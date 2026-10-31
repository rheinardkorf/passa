// Local development against Moto (see compose.yaml): set up storage, run the
// edge proxy with the auth app, and publish a folder. Run with `pnpm local`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateAliasCommand, CreateKeyCommand, KMSClient, NotFoundException } from '@aws-sdk/client-kms';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { CreateSecretCommand, ResourceExistsException, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CreateEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createAuthApp, KmsSigningKey, loadAuthSecrets, newAuthSecrets, SesMailer } from '@passa/auth';
import { createMcpApp, Publisher } from '@passa/mcp';
import {
  bootstrapAdmins,
  createTables,
  Events,
  loadConfigFile,
  loadTokenKey,
  OidcStore,
  senderDomain,
  signingKeyKey,
  SiteFiles,
  Store,
  TableEdgeStore,
} from '@passa/shared';
import { startProxy } from './proxy.ts';

const PORT = Number(process.env.PASSA_LOCAL_PORT ?? 8080);
const aws = {
  endpoint: process.env.PASSA_LOCAL_AWS_ENDPOINT ?? 'http://127.0.0.1:5005',
  region: 'ap-southeast-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
};
const tables = { main: 'passa-local', events: 'passa-local-events', edge: 'passa-local-edge' };
const buckets = { sites: 'passa-local-sites', uploads: 'passa-local-uploads' };
const KID = 'local';
const TOKEN_KEY = 'alias/passa-local-tokens';
const AUTH_SECRET = 'passa-local-auth';

const out = (line: string) => process.stdout.write(`${line}\n`);

function wiring() {
  const config = loadConfigFile(existsSync('config.yml') ? 'config.yml' : 'config.example.yml');
  const client = new DynamoDBClient(aws);
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({ ...aws, forcePathStyle: true });
  const ses = new SESv2Client(aws);
  const kms = new KMSClient(aws);
  const secrets = new SecretsManagerClient(aws);
  const store = new Store(db, tables.main);
  const edge = new TableEdgeStore(db, tables.edge);
  const events = new Events(db, tables.events, config.retention.eventYears);
  const origin = (siteId: string) => `http://${siteId}.localhost:${PORT}`;
  const deps = { store, edge, config, events, files: new SiteFiles(s3, buckets), siteUrl: (id: string) => `${origin(id)}/` };
  return { config, client, db, s3, ses, kms, secrets, store, edge, events, deps, origin };
}

async function authApp(w: ReturnType<typeof wiring>) {
  const ses = new SesMailer(w.ses, w.config.email.from);
  const { cookieKeys, siteKeys } = await loadAuthSecrets(w.secrets, AUTH_SECRET);
  const [siteKey] = siteKeys;
  if (!siteKey) throw new Error('no site key');
  return createAuthApp({
    store: w.store,
    events: w.events,
    config: w.config,
    // Moto accepts the email but delivers nothing, so it's printed here too.
    mailer: {
      async send(email) {
        await ses.send(email);
        out(`\nEmail to ${email.to}: ${email.subject}\n${email.text}`);
      },
    },
    siteKey: async () => siteKey,
    urls: { auth: `http://localhost:${PORT}`, mcp: `http://mcp.localhost:${PORT}`, site: w.origin },
    oidc: new OidcStore(w.db, tables.main),
    tokenSigner: await KmsSigningKey.load(w.kms, TOKEN_KEY),
    cookieKeys,
    log: (message, data) => process.stderr.write(`${message} ${JSON.stringify(data ?? {})}\n`),
  });
}

async function mcpApp(w: ReturnType<typeof wiring>) {
  return createMcpApp({
    ...w.deps,
    oidc: new OidcStore(w.db, tables.main),
    tokenKeys: [await loadTokenKey(w.kms, TOKEN_KEY)],
    issuer: `http://localhost:${PORT}`,
    resource: `http://mcp.localhost:${PORT}/mcp`,
    log: (message, data) => process.stderr.write(`${message} ${JSON.stringify(data ?? {})}\n`),
  });
}

// The access-token signing key: ECC P-256 in KMS, as in AWS.
async function ensureTokenKey(kms: KMSClient) {
  try {
    await KmsSigningKey.load(kms, TOKEN_KEY);
  } catch (err) {
    if (!(err instanceof NotFoundException)) throw err;
    const { KeyMetadata } = await kms.send(new CreateKeyCommand({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY', Description: 'Passa local access tokens' }));
    await kms.send(new CreateAliasCommand({ AliasName: TOKEN_KEY, TargetKeyId: KeyMetadata?.KeyId }));
  }
}

function readFolder(dir: string): { path: string; content: Uint8Array }[] {
  const root = resolve(dir);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = join(entry.parentPath, entry.name);
      return { path: relative(root, full).split('\\').join('/'), content: new Uint8Array(readFileSync(full)) };
    });
}

const commands: Record<string, (w: ReturnType<typeof wiring>, args: string[]) => Promise<void>> = {
  async setup(w) {
    await createTables(w.client, tables);
    for (const Bucket of Object.values(buckets)) {
      try {
        await w.s3.send(new CreateBucketCommand({ Bucket, CreateBucketConfiguration: { LocationConstraint: 'ap-southeast-2' } }));
      } catch (err) {
        if ((err as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw err;
      }
    }
    await w.ses.send(new CreateEmailIdentityCommand({ EmailIdentity: senderDomain(w.config.email.from) }));
    await ensureTokenKey(w.kms);
    try {
      await w.secrets.send(new CreateSecretCommand({ Name: AUTH_SECRET, SecretString: JSON.stringify(newAuthSecrets(KID)) }));
    } catch (err) {
      if (!(err instanceof ResourceExistsException)) throw err;
    }
    // As on deploy: copy the site keys to where the edge reads them.
    for (const { kid, secret } of (await loadAuthSecrets(w.secrets, AUTH_SECRET)).siteKeys) await w.edge.set(signingKeyKey(kid), secret);
    const admins = await bootstrapAdmins(w.store, w.config.admins);
    out(`Ready. Admins: ${admins.map((u) => u.email).join(', ')}`);
  },

  async proxy(w) {
    await startProxy({ edge: w.edge, s3: w.s3, bucket: buckets.sites, cdnAllowlist: w.config.cdnAllowlist, auth: await authApp(w), mcp: await mcpApp(w) }, PORT);
    out(`Sites at http://<site-id>.localhost:${PORT}/, sign-in at http://localhost:${PORT}/ (Ctrl-C to stop)`);
    out(`MCP server: http://mcp.localhost:${PORT}/mcp (claude mcp add --transport http passa-local http://mcp.localhost:${PORT}/mcp)`);
    out('Sign-in emails are printed here.');
  },

  async publish(w, [dir, ...title]) {
    if (!dir) throw new Error('usage: pnpm local publish <folder> [title]');
    const owner = await w.store.findUserByEmail(w.config.admins[0] ?? '');
    if (!owner) throw new Error('run `pnpm local setup` first');
    const site = await new Publisher(w.deps).publish({ userId: owner.id }, { title: title.join(' ') || dir, content: { files: readFolder(dir) } });
    out(`Published ${site.url} (${site.files} files${site.skipped.length ? `, skipped ${site.skipped.join(', ')}` : ''})`);
    out(`Open it and sign in as ${owner.email}.`);
  },
};

export async function main(argv: string[]): Promise<void> {
  const [name = '', ...args] = argv;
  const command = commands[name];
  if (!command) throw new Error(`usage: pnpm local <${Object.keys(commands).join('|')}>`);
  await command(wiring(), args);
}
