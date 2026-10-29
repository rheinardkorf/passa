// Local development against Moto (see compose.yaml): set up storage, run the
// edge proxy, publish a folder, and print a sign-in link. Run with `pnpm local`.
// Until magic-link sign-in exists (M1 step 5), `signin` stands in for it.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Publisher } from '@passa/mcp';
import {
  bootstrapAdmins,
  createTables,
  Events,
  handoffUrl,
  loadConfigFile,
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

const out = (line: string) => process.stdout.write(`${line}\n`);

function wiring() {
  const config = loadConfigFile(existsSync('config.yml') ? 'config.yml' : 'config.example.yml');
  const client = new DynamoDBClient(aws);
  const db = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
  const s3 = new S3Client({ ...aws, forcePathStyle: true });
  const store = new Store(db, tables.main);
  const edge = new TableEdgeStore(db, tables.edge);
  const origin = (siteId: string) => `http://${siteId}.localhost:${PORT}`;
  const deps = { store, edge, config, files: new SiteFiles(s3, buckets), events: new Events(db, tables.events), siteUrl: (id: string) => `${origin(id)}/` };
  return { config, client, s3, store, edge, deps, origin };
}

async function signinLink(w: ReturnType<typeof wiring>, siteId: string, path = '/') {
  const site = await w.store.getSite(siteId);
  if (!site) throw new Error(`no site ${siteId}`);
  const key = { kid: KID, secret: await w.edge.get(signingKeyKey(KID)) };
  return handoffUrl({ key, siteId, accessVersion: site.accessVersion, origin: w.origin(siteId), path, cookieLifetime: w.config.lifetimes.siteCookie });
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
    try {
      await w.edge.get(signingKeyKey(KID));
    } catch {
      await w.edge.set(signingKeyKey(KID), randomBytes(32).toString('hex'));
    }
    const admins = await bootstrapAdmins(w.store, w.config.admins);
    out(`Ready. Admins: ${admins.map((u) => u.email).join(', ')}`);
  },

  async proxy(w) {
    await startProxy({ edge: w.edge, s3: w.s3, bucket: buckets.sites, cdnAllowlist: w.config.cdnAllowlist }, PORT);
    out(`Sites at http://<site-id>.localhost:${PORT}/ (Ctrl-C to stop)`);
  },

  async publish(w, [dir, ...title]) {
    if (!dir) throw new Error('usage: pnpm local publish <folder> [title]');
    const owner = await w.store.findUserByEmail(w.config.admins[0] ?? '');
    if (!owner) throw new Error('run `pnpm local setup` first');
    const site = await new Publisher(w.deps).publish({ userId: owner.id }, { title: title.join(' ') || dir, content: { files: readFolder(dir) } });
    out(`Published ${site.url} (${site.files} files${site.skipped.length ? `, skipped ${site.skipped.join(', ')}` : ''})`);
    out(`Sign in: ${await signinLink(w, site.site_id)}`);
  },

  async signin(w, [siteId, path]) {
    if (!siteId) throw new Error('usage: pnpm local signin <site-id> [path]');
    out(await signinLink(w, siteId, path));
  },
};

export async function main(argv: string[]): Promise<void> {
  const [name = '', ...args] = argv;
  const command = commands[name];
  if (!command) throw new Error(`usage: pnpm local <${Object.keys(commands).join('|')}>`);
  await command(wiring(), args);
}
