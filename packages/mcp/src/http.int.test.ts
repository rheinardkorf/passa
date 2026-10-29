// The MCP endpoint's token checks, with tokens signed here by a test key in
// the shape auth. issues. The end-to-end test with real tokens from auth.
// is in the edge package, which runs both.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OidcStore } from '@passa/shared';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpApp } from './http.ts';
import { addUser, type TestEnv, testEnv } from './testing/moto.ts';

const ISSUER = 'https://auth.example.com';
const RESOURCE = 'https://mcp.example.com/mcp';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });

let env: TestEnv;
let oidc: OidcStore;
let server: Server;
let base: string;

beforeAll(async () => {
  env = await testEnv();
  oidc = new OidcStore(env.db, env.tables.main);
  await addUser(env, { id: 'alice' });
  await addUser(env, { id: 'carol', status: 'disabled' });
  const app = createMcpApp({ ...env, oidc, tokenKeys: [{ kid: 'k1', publicKey }], issuer: ISSUER, resource: RESOURCE, log: () => undefined });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

async function grant(accountId: string): Promise<string> {
  const id = randomBytes(8).toString('hex');
  await oidc.adapter('Grant').upsert(id, { jti: id, accountId, clientId: 'c1', kind: 'Grant' }, 3600);
  return id;
}

type Claims = Record<string, unknown>;

async function token(claims: Claims = {}, options: { key?: typeof privateKey; kid?: string; typ?: string; expires?: string } = {}): Promise<string> {
  const gid = 'gid' in claims ? claims.gid : await grant(String(claims.sub ?? 'alice'));
  return new SignJWT({ scope: 'publish', client_id: 'c1', gid, ...claims })
    .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? 'k1', typ: options.typ ?? 'at+jwt' })
    .setSubject(String(claims.sub ?? 'alice'))
    .setIssuer(String(claims.iss ?? ISSUER))
    .setAudience(String(claims.aud ?? RESOURCE))
    .setIssuedAt()
    .setExpirationTime(options.expires ?? '1h')
    .sign(options.key ?? privateKey);
}

const post = (headers: Record<string, string> = {}, body: unknown = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) =>
  fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

async function connect(accessToken: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } } });
  // The SDK's transport types don't satisfy exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
  return client;
}

describe('the MCP endpoint', () => {
  it('points clients without a token to its metadata (R21)', async () => {
    const r = await post();
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"');
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await fetch(`${base}${path}`)).json()).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ['publish'],
        bearer_methods_supported: ['header'],
      });
    }
  });

  it('runs the tools as the token’s user', async () => {
    const client = await connect(await token());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('publish');
    const result = await client.callTool({ name: 'publish', arguments: { title: 'Over HTTP', files: [{ path: 'index.html', content: '<h1>hi</h1>' }] } });
    const site = JSON.parse((result.content as { text: string }[])[0]?.text ?? '{}') as { site_id: string };
    expect((await env.store.getSite(site.site_id))?.ownerId).toBe('alice');
    await client.close();
  });

  it('refuses tokens that are forged, expired, for another audience or issuer, or of the wrong type (R26)', async () => {
    const cases: [string, Promise<string>][] = [
      ['other key', token({}, { key: other.privateKey })],
      ['unknown kid', token({}, { kid: 'k9' })],
      ['expired', token({}, { expires: '-1m' })],
      ['other audience', token({ aud: 'https://elsewhere.example/mcp' })],
      ['other issuer', token({ iss: 'https://evil.example' })],
      ['id token type', token({}, { typ: 'JWT' })],
      ['no grant id', token({ gid: undefined })],
    ];
    for (const [name, t] of cases) {
      const r = await post({ authorization: `Bearer ${await t}` });
      expect(r.status, name).toBe(401);
      expect(r.headers.get('www-authenticate'), name).toContain('error="invalid_token"');
    }
    expect((await post({ authorization: 'Bearer not-a-jwt' })).status).toBe(401);
    expect((await post({ authorization: 'Basic abc' })).status).toBe(401);
  });

  it('refuses a token without the publish scope', async () => {
    const r = await post({ authorization: `Bearer ${await token({ scope: 'openid' })}` });
    expect(r.status).toBe(403);
    expect(r.headers.get('www-authenticate')).toContain('error="insufficient_scope", scope="publish"');
  });

  it('refuses a token as soon as its grant is revoked (R26)', async () => {
    const gid = await grant('alice');
    const t = await token({ gid });
    expect((await post({ authorization: `Bearer ${t}` })).status).toBe(200);
    await oidc.revokeGrant(gid);
    expect((await post({ authorization: `Bearer ${t}` })).status).toBe(401);
    const day = new Date().toISOString().slice(0, 10);
    const { Items = [] } = await env.db.send(new QueryCommand({ TableName: env.tables.events, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `DAY#${day}` } }));
    expect(Items.some((e) => e.action === 'mcp.token' && e.detail === 'ERR_GRANT_REVOKED')).toBe(true);
  });

  it('still checks that the user is an active publisher (R8)', async () => {
    const client = await connect(await token({ sub: 'carol' }));
    const result = await client.callTool({ name: 'find_sites', arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it('only accepts POST, and answers bad JSON generically', async () => {
    const t = await token();
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(405);
    const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
  });
});
