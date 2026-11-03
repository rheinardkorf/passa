// Signing in to a deployment (R99–R102): OAuth with PKCE and a loopback
// redirect, as agents do, and tokens kept in a file only the user can read.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { form, json, request } from './http.ts';

// What the CLI keeps per MCP server.
export type ServerCredentials = {
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  accessToken: string;
  accessExpires: number; // ms since the epoch
  refreshToken?: string;
};
export type Credentials = { current?: string; servers: Record<string, ServerCredentials> };

export class LoginNeeded extends Error {
  constructor(server: string) {
    super(`Not signed in to ${server}. Run: passa login ${server}`);
  }
}

const SCOPE = 'publish offline_access';
const CLIENT_NAME = 'Passa CLI';
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export const configDir = (env = process.env) => env.PASSA_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'passa');
const credentialsFile = (dir: string) => join(dir, 'credentials.json');

// The MCP endpoint, as given: a bare host means its /mcp over https.
export function serverUrl(input: string): string {
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  const u = new URL(withScheme);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/mcp';
  return `${u.origin}${u.pathname}`;
}

export function readCredentials(dir = configDir()): Credentials {
  const file = credentialsFile(dir);
  if (!existsSync(file)) return { servers: {} };
  // R101: a token file anyone else can read isn't used.
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`${file} can be read by other users. Fix it with: chmod 600 "${file}", then sign in again (passa login), since its tokens may have been seen.`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Credentials>;
  return { ...(parsed.current ? { current: parsed.current } : {}), servers: parsed.servers ?? {} };
}

export function writeCredentials(credentials: Credentials, dir = configDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  const file = credentialsFile(dir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

// The server to use: the one given, else $PASSA_SERVER, else the current one
// (the last signed in to, or chosen with passa use).
export function chooseServer(given: string | undefined, credentials: Credentials, env = process.env): string {
  if (given) return serverUrl(given);
  if (env.PASSA_SERVER) return serverUrl(env.PASSA_SERVER);
  if (credentials.current) return credentials.current;
  throw new Error('No Passa server yet. Run: passa login <server>, such as passa login mcp.example.com');
}

// Makes a server already signed in to the current one, with no sign-in.
export function useServer(server: string, dir = configDir()): void {
  const credentials = readCredentials(dir);
  if (!credentials.servers[server]) throw new LoginNeeded(server);
  writeCredentials({ ...credentials, current: server }, dir);
}

// The MCP server's authorization server, from its metadata (RFC 9728, RFC 8414).
async function discover(server: string) {
  const u = new URL(server);
  const resource = json(await request(`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`));
  const issuer = Array.isArray(resource.authorization_servers) ? String(resource.authorization_servers[0] ?? '') : '';
  if (!issuer) throw new Error(`${server} doesn't look like a Passa MCP server: it names no authorization server`);
  const as = json(await request(`${issuer}/.well-known/oauth-authorization-server`));
  for (const field of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
    if (typeof as[field] !== 'string') throw new Error(`${issuer} has no ${field}`);
  }
  return {
    issuer,
    authorize: String(as.authorization_endpoint),
    token: String(as.token_endpoint),
    register: String(as.registration_endpoint),
    ...(typeof as.revocation_endpoint === 'string' ? { revoke: as.revocation_endpoint } : {}),
  };
}

const tokensFrom = (body: Record<string, unknown>, now: number) => {
  if (typeof body.access_token !== 'string') throw new Error(`the token endpoint said: ${String(body.error_description ?? body.error ?? 'no token')}`);
  return {
    accessToken: body.access_token,
    accessExpires: now + Number(body.expires_in ?? 3600) * 1000,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
  };
};

export type LoginOptions = {
  dir?: string;
  // Opens the authorization URL; the default opens the system browser.
  open?: (url: string) => Promise<void> | void;
  // Told the URL, so it can be shown when the browser can't be opened.
  show?: (url: string) => void;
  now?: () => number;
};

// R99: registers once per server, then the browser does the rest.
export async function login(server: string, options: LoginOptions = {}): Promise<ServerCredentials> {
  const dir = options.dir ?? configDir();
  const now = options.now ?? Date.now;
  const credentials = readCredentials(dir);
  const endpoints = await discover(server);
  let clientId = credentials.servers[server]?.issuer === endpoints.issuer ? credentials.servers[server]?.clientId : undefined;
  if (!clientId) {
    const reg = json(await request(endpoints.register, {
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME, redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native',
      }),
    }));
    if (typeof reg.client_id !== 'string') throw new Error(`${endpoints.issuer} refused to register the CLI: ${String(reg.error_description ?? reg.error ?? 'no client_id')}`);
    clientId = reg.client_id;
  }

  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const { redirectUri, code } = await loopback(state, async (redirect) => {
    const url = `${endpoints.authorize}?${new URLSearchParams({
      client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE, state, resource: server,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    })}`;
    options.show?.(url);
    await (options.open ?? openBrowser)(url);
  });

  const body = json(await request(endpoints.token, form({
    grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId, resource: server,
  })));
  const saved: ServerCredentials = {
    issuer: endpoints.issuer, clientId, tokenEndpoint: endpoints.token,
    ...(endpoints.revoke ? { revocationEndpoint: endpoints.revoke } : {}),
    ...tokensFrom(body, now()),
  };
  writeCredentials({ current: server, servers: { ...credentials.servers, [server]: saved } }, dir);
  return saved;
}

// Waits for the one redirect with this state on 127.0.0.1, then closes (R99).
function loopback(state: string, start: (redirectUri: string) => Promise<void>): Promise<{ redirectUri: string; code: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const done = (err?: Error, code?: string) => {
      clearTimeout(timer);
      server.close();
      if (err) reject(err);
      else resolve({ redirectUri, code: code ?? '' });
    };
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const page = (text: string) => `<!doctype html><meta charset="utf-8"><title>Passa</title><body style="font:16px system-ui;margin:3rem">${text}</body>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(page(error || !code ? 'Sign-in didn\'t finish. You can close this tab.' : 'Signed in. You can close this tab and go back to the terminal.'));
      done(error || !code ? new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${error ?? 'no code'}`) : undefined, code ?? undefined);
    });
    const timer = setTimeout(() => done(new Error('Sign-in took too long. Run passa login again.')), LOGIN_TIMEOUT_MS);
    server.on('error', (err) => done(err));
    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
      start(redirectUri).catch((err: unknown) => done(err instanceof Error ? err : new Error(String(err))));
    });
  });
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  await new Promise<void>((resolve) => {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => resolve()); // the URL was shown, so it can be opened by hand
    child.unref();
    resolve();
  });
}

// R100: an access token for the server, refreshed when it's about to expire.
export async function accessToken(server: string, options: { dir?: string; now?: () => number; force?: boolean } = {}): Promise<string> {
  const dir = options.dir ?? configDir();
  const now = (options.now ?? Date.now)();
  const credentials = readCredentials(dir);
  const saved = credentials.servers[server];
  if (!saved) throw new LoginNeeded(server);
  if (!options.force && saved.accessExpires - 60_000 > now) return saved.accessToken;
  if (!saved.refreshToken) throw new LoginNeeded(server);
  const body = json(await request(saved.tokenEndpoint, form({ grant_type: 'refresh_token', refresh_token: saved.refreshToken, client_id: saved.clientId, resource: server })));
  if (typeof body.access_token !== 'string') {
    // The refresh token was revoked or has expired: only a new sign-in helps.
    writeCredentials({ ...credentials, servers: { ...credentials.servers, [server]: { ...saved, accessToken: '', accessExpires: 0 } } }, dir);
    throw new LoginNeeded(server);
  }
  const refreshed = { ...saved, ...tokensFrom(body, now) };
  writeCredentials({ ...credentials, servers: { ...credentials.servers, [server]: refreshed } }, dir);
  return refreshed.accessToken;
}

// R102: revokes the refresh token at the server, then forgets the server.
export async function logout(server: string, options: { dir?: string } = {}): Promise<{ revoked: boolean }> {
  const dir = options.dir ?? configDir();
  const credentials = readCredentials(dir);
  const saved = credentials.servers[server];
  if (!saved) return { revoked: false };
  let revoked = false;
  if (saved.revocationEndpoint && saved.refreshToken) {
    const reply = await request(saved.revocationEndpoint, form({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: saved.clientId })).catch(() => undefined);
    revoked = reply?.status === 200;
  }
  const rest = Object.fromEntries(Object.entries(credentials.servers).filter(([url]) => url !== server));
  const current = credentials.current === server ? Object.keys(rest)[0] : credentials.current;
  writeCredentials({ ...(current ? { current } : {}), servers: rest }, dir);
  return { revoked };
}
