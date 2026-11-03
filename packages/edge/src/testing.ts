// The whole local stack for tests, against Moto: the proxy running the edge
// handler, with the auth app and the MCP endpoint behind it.
import { request as httpRequest, type RequestListener } from 'node:http';
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

export type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };

// Sends a request to the proxy on 127.0.0.1, as the given host.
export function sendTo(port: number, host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { host, ...init.headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

// A browser's view: cookies kept per host, redirects followed by hand.
export class Browser {
  jar = new Map<string, Map<string, string>>();
  readonly #port: number;

  constructor(port: number) {
    this.#port = port;
  }

  async open(url: string, form?: Record<string, string>): Promise<Reply & { url: URL }> {
    const u = new URL(url);
    const cookies = this.jar.get(u.host) ?? new Map<string, string>();
    this.jar.set(u.host, cookies);
    const headers: Record<string, string> = { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body: string | undefined;
    if (form) {
      headers.origin = u.origin;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ ...form, csrf: cookies.get('__Host-passa-csrf') ?? '' }).toString();
    }
    const r = await sendTo(this.#port, u.host, u.pathname + u.search, { method: form ? 'POST' : 'GET', headers, ...(body ? { body } : {}) });
    for (const c of (r.headers['set-cookie'] as string[] | undefined) ?? []) {
      const pair = c.slice(0, c.indexOf(';'));
      cookies.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    return { ...r, url: u };
  }

  // Follows redirects and continuing pages while they stay on localhost hosts
  // the proxy serves; stops at a page, or at a redirect anywhere else.
  async follow(url: string, form?: Record<string, string>): Promise<Reply & { url: URL }> {
    let reply = await this.open(url, form);
    for (let i = 0; i < 12; i++) {
      const refresh = /content="0;url=([^"]+)"/.exec(reply.body)?.[1]?.replaceAll('&amp;', '&');
      const next = reply.status >= 300 && reply.status < 400 ? String(reply.headers.location) : refresh;
      if (!next) break;
      const to = new URL(next, reply.url);
      if (!to.host.endsWith(`localhost:${this.#port}`)) return { ...reply, url: to };
      reply = await this.open(to.href);
    }
    return reply;
  }
}
