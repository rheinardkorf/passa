// Sites end to end: publish with the real tools into Moto, then browse through
// the local proxy, which runs the real edge handler.
import { request as httpRequest } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { Publisher } from '@passa/mcp';
import { addUser, type TestEnv, testEnv } from '@passa/mcp/testing';
import { contentSecurityPolicy, handoffUrl } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startProxy } from './proxy.ts';

let env: TestEnv;
let server: Server;
let port: number;
let publisher: Publisher;
const key = { kid: 'k1', secret: 'c'.repeat(64) };
const alice = { userId: 'alice' };

beforeAll(async () => {
  env = await testEnv();
  await addUser(env, { id: 'alice' });
  await env.edge.set('k:k1', key.secret);
  server = await startProxy({ edge: env.edge, s3: env.s3, bucket: env.buckets.sites, cdnAllowlist: env.config.cdnAllowlist }, 0);
  port = (server.address() as AddressInfo).port;
  publisher = new Publisher({ ...env, siteUrl: (id) => `http://${id}.localhost:${port}/` });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// Sends a request with a site's Host header to the proxy on 127.0.0.1.
function get(siteId: string, path: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host: `${siteId}.localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Follows the sign-in handoff the way a browser would, and returns the cookie.
async function signIn(siteId: string, accessVersion = 1): Promise<string> {
  const url = new URL(handoffUrl({ key, siteId, accessVersion, origin: `http://${siteId}.localhost:${port}`, path: '/', cookieLifetime: 3600 }));
  const r = await get(siteId, url.pathname + url.search);
  expect(r.status).toBe(302);
  const set = (r.headers['set-cookie'] as string[])[0] ?? '';
  return set.slice(0, set.indexOf(';'));
}

const page = (body: string) => [{ path: 'index.html', content: new TextEncoder().encode(`<!doctype html>${body}`) }];

describe('viewing a private site', () => {
  it('redirects to sign in, then serves the current version with site headers', async () => {
    const site = await publisher.publish(alice, { title: 'Hello', content: { files: [...page('<h1>Hello</h1>'), { path: 'docs/index.html', content: new TextEncoder().encode('docs') }] } });
    expect(site.url).toBe(`http://${site.site_id}.localhost:${port}/`);

    const anonymous = await get(site.site_id, '/');
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toBe(`http://auth.localhost:${port}/site/signin?site=${site.site_id}&path=%2F`);

    const cookie = await signIn(site.site_id);
    const r = await get(site.site_id, '/', { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toContain('<h1>Hello</h1>');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe(contentSecurityPolicy(env.config.cdnAllowlist));
    expect(r.headers['cache-control']).toBe('private, no-cache');
    expect((await get(site.site_id, '/docs', { cookie })).body).toBe('docs');
    expect((await get(site.site_id, '/missing.html', { cookie })).status).toBe(404);

    // Revalidation: same version, same ETag, no body.
    expect((await get(site.site_id, '/', { cookie, 'if-none-match': String(r.headers.etag) })).status).toBe(304);
  });

  it('shows updates and rollbacks immediately', async () => {
    const site = await publisher.publish(alice, { title: 'Versions', content: { files: page('v1') } });
    const cookie = await signIn(site.site_id);
    await publisher.update(alice, { siteId: site.site_id, content: { files: page('v2') } });
    expect((await get(site.site_id, '/', { cookie })).body).toContain('v2');
    await publisher.rollback(alice, { siteId: site.site_id, versionId: site.current_version });
    expect((await get(site.site_id, '/', { cookie })).body).toContain('v1');
  });

  it('stops serving a site as soon as it is deleted', async () => {
    const site = await publisher.publish(alice, { title: 'Going', content: { files: page('bye') } });
    const cookie = await signIn(site.site_id);
    await publisher.delete(alice, { siteId: site.site_id, now: false });
    const r = await get(site.site_id, '/', { cookie });
    expect(r.status).toBe(302);
    expect(String(r.headers.location)).toContain('/site/signin');
  });

  it('refuses a cookie for one site on another', async () => {
    const a = await publisher.publish(alice, { title: 'A', content: { files: page('a') } });
    const b = await publisher.publish(alice, { title: 'B', content: { files: page('b') } });
    const cookie = await signIn(a.site_id);
    expect((await get(b.site_id, '/', { cookie })).status).toBe(302);
  });

  it('only allows GET and HEAD', async () => {
    const r = await new Promise<number>((resolve) => {
      httpRequest({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { host: `abcdefghijkm.localhost:${port}` } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(r).toBe(405);
  });
});
