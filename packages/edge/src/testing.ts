// The whole local stack for tests, against Moto: the proxy running the edge
// handler, with the auth app and the MCP endpoint behind it.
import type { RequestListener } from 'node:http';
import type { AddressInfo, Server } from 'node:net';
import { createAuthApp, type Email } from '@passa/auth';
import { authTestDeps } from '@passa/auth/testing';
import { createMcpApp, Publisher } from '@passa/mcp';
import { type TestEnv, testEnv } from '@passa/mcp/testing';
import { loadTokenKey, OidcStore } from '@passa/shared';
import { startProxy } from './proxy.ts';

export type Stack = {
  env: TestEnv;
  server: Server;
  port: number;
  publisher: Publisher;
  sent: Email[]; // every email the auth app sent, newest last
  close: () => Promise<void>;
};

export async function startStack(): Promise<Stack> {
  const env = await testEnv();
  // The apps need the proxy's port for their URLs, so they're created after.
  let auth: RequestListener = () => undefined;
  let mcp: RequestListener = () => undefined;
  const server = await startProxy({
    edge: env.edge,
    s3: env.s3,
    bucket: env.buckets.sites,
    cdnAllowlist: env.config.cdnAllowlist,
    auth: (req, res) => auth(req, res),
    mcp: (req, res) => mcp(req, res),
  }, 0);
  const port = (server.address() as AddressInfo).port;
  const siteUrl = (id: string) => `http://${id}.localhost:${port}/`;
  const deps = await authTestDeps(env, { auth: `http://localhost:${port}`, mcp: `http://mcp.localhost:${port}`, site: (id) => `http://${id}.localhost:${port}` });
  auth = createAuthApp(deps);
  mcp = createMcpApp({
    ...env,
    siteUrl,
    oidc: new OidcStore(env.db, env.tables.main),
    tokenKeys: [await loadTokenKey(deps.kms, deps.tokenKeyId)],
    issuer: `http://localhost:${port}`,
    resource: `http://mcp.localhost:${port}/mcp`,
    log: () => undefined,
  });
  return {
    env,
    server,
    port,
    publisher: new Publisher({ ...env, siteUrl }),
    sent: deps.sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
