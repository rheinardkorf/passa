// Folder sync end to end: begin_upload with a site compares the folder with the
// current version, and update with sync: true makes the site exactly the folder.
// Moto doesn't check presigned URLs, so uploads are written straight to the bucket.
import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './server.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

let env: TestEnv;
type Call = (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: () => Record<string, unknown> }>;
let call: Call;

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  const server = createServer(env, { userId: 'alice' }, () => undefined);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
});

const html = (body: string) => `<!doctype html><title>t</title>${body}`;
const sha256 = (content: string) => createHash('sha256').update(content).digest('hex');
type Folder = Record<string, string>;
const manifest = (folder: Folder) => Object.entries(folder).map(([path, content]) => ({ path, size: Buffer.byteLength(content), sha256: sha256(content) }));

async function publish(folder: Folder): Promise<string> {
  const r = await call('publish', { title: 'Synced', files: Object.entries(folder).map(([path, content]) => ({ path, content })) });
  return String(r.json().site_id);
}

// begin_upload with the site, upload what it asks for, finish_upload.
async function prepare(siteId: string, folder: Folder) {
  const begun = (await call('begin_upload', { site_id: siteId, files: manifest(folder) })).json();
  const uploads = (begun.uploads ?? []) as { path: string }[];
  for (const { path } of uploads) {
    await env.s3.send(new PutObjectCommand({ Bucket: env.buckets.uploads, Key: `${String(begun.upload_id)}/${path}`, Body: folder[path] ?? '' }));
  }
  if (begun.upload_id) expect((await call('finish_upload', { upload_id: begun.upload_id })).isError).toBe(false);
  return { begun, asked: uploads.map((u) => u.path).sort() };
}

async function filesOf(siteId: string) {
  const files = (await call('get_site', { site_id: siteId })).json().files as { path: string; sha256: string }[];
  return Object.fromEntries(files.map((f) => [f.path, f.sha256]));
}

describe('folder sync', () => {
  it('uploads only new and changed files, keeps unchanged ones, and removes what the folder lacks', async () => {
    const siteId = await publish({ 'index.html': html('home'), 'about.html': html('about'), 'old.css': 'p{}' });
    const folder = { 'index.html': html('home'), 'about.html': html('about, updated'), 'new.html': html('new') };
    const { begun, asked } = await prepare(siteId, folder);
    expect(asked).toEqual(['about.html', 'new.html']);
    expect(begun.sync).toMatchObject({ unchanged: 1, remove: ['old.css'] });

    const updated = await call('update', { site_id: siteId, upload_id: begun.upload_id, sync: true });
    expect(updated.isError, updated.text).toBe(false);
    expect(updated.json()).toMatchObject({ files: 3, changed: 2, removed: 1 });
    expect(await filesOf(siteId)).toEqual(Object.fromEntries(Object.entries(folder).map(([p, c]) => [p, sha256(c)])));
  });

  it('says a folder that matches the site is up to date, with nothing to upload', async () => {
    const folder = { 'index.html': html('same') };
    const siteId = await publish(folder);
    const begun = (await call('begin_upload', { site_id: siteId, files: manifest(folder) })).json();
    expect(begun).toMatchObject({ site_id: siteId, up_to_date: true });
    expect(begun.upload_id).toBeUndefined();
  });

  it('removes files with nothing to upload', async () => {
    const siteId = await publish({ 'index.html': html('keep'), 'gone.html': html('gone') });
    const { begun, asked } = await prepare(siteId, { 'index.html': html('keep') });
    expect(asked).toEqual([]);
    expect((await call('update', { site_id: siteId, upload_id: begun.upload_id, sync: true })).isError).toBe(false);
    expect(Object.keys(await filesOf(siteId))).toEqual(['index.html']);
  });

  it('uploads files given without a hash', async () => {
    const siteId = await publish({ 'index.html': html('home') });
    const begun = (await call('begin_upload', { site_id: siteId, files: [{ path: 'index.html', size: Buffer.byteLength(html('home')) }] })).json();
    expect((begun.uploads as { path: string }[]).map((u) => u.path)).toEqual(['index.html']);
  });

  it('refuses a sync if the site changed after begin_upload', async () => {
    const siteId = await publish({ 'index.html': html('v1') });
    const { begun } = await prepare(siteId, { 'index.html': html('v2') });
    await call('update', { site_id: siteId, edits: [{ path: 'index.html', old: 'v1', new: 'v1b' }] });
    const r = await call('update', { site_id: siteId, upload_id: begun.upload_id, sync: true });
    expect([r.isError, r.text]).toEqual([true, expect.stringContaining('changed since begin_upload')]);
  });

  it('keeps a sync upload to its own site, and needs one for sync', async () => {
    const siteId = await publish({ 'index.html': html('a') });
    const other = await publish({ 'index.html': html('b') });
    const { begun } = await prepare(siteId, { 'index.html': html('a2') });
    expect((await call('publish', { title: 'Wrong', upload_id: begun.upload_id })).text).toContain('use it with update and sync: true');
    expect((await call('update', { site_id: other, upload_id: begun.upload_id, sync: true })).text).toContain('wasn\'t started for this site');
    expect((await call('update', { site_id: siteId, files: [{ path: 'index.html', content: html('x') }], sync: true })).isError).toBe(true);

    const plain = (await call('begin_upload', { files: manifest({ 'index.html': html('p') }) })).json();
    await env.s3.send(new PutObjectCommand({ Bucket: env.buckets.uploads, Key: `${String(plain.upload_id)}/index.html`, Body: html('p') }));
    await call('finish_upload', { upload_id: plain.upload_id });
    expect((await call('update', { site_id: siteId, upload_id: plain.upload_id, sync: true })).text).toContain('wasn\'t started for this site');
  });
});
