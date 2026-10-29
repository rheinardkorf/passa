// The MCP endpoint on mcp.<domain>: checks the access token on every request
// (R21, R26), then runs the publishing tools for that caller. Stateless: one
// server and transport per request, answering with plain JSON.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { OidcStore, TokenKey } from '@passa/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { errors as joseErrors, type JWTPayload, jwtVerify } from 'jose';
import type { Deps } from './publisher.ts';
import { createServer, type Log } from './server.ts';

export const PUBLISH_SCOPE = 'publish';

export type McpHttpDeps = Deps & {
  oidc: OidcStore;
  // Public halves of the access-token signing keys (from KMS), by kid.
  tokenKeys: TokenKey[];
  issuer: string; // the auth. origin
  resource: string; // this endpoint's URL, the tokens' audience
  clientIp?: (req: Request) => string;
  log: Log;
};

type Verified = { userId: string; clientId: string };

class TokenRefused extends Error {}

export function createMcpApp(deps: McpHttpDeps): express.Express {
  const metadataUrl = `${new URL(deps.resource).origin}/.well-known/oauth-protected-resource/mcp`;
  const ipOf = (req: Request) => (deps.clientIp ? deps.clientIp(req) : (req.socket.remoteAddress ?? ''));
  const keyFor = async (header: { kid?: string }) => {
    const key = deps.tokenKeys.find((k) => k.kid === header.kid);
    if (!key) throw new joseErrors.JWKSNoMatchingKey();
    return key.publicKey;
  };

  async function verify(token: string): Promise<Verified> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keyFor, {
        algorithms: ['ES256'],
        issuer: deps.issuer,
        audience: deps.resource,
        typ: 'at+jwt',
        requiredClaims: ['sub', 'exp', 'gid', 'client_id'],
      }));
    } catch (err) {
      throw new TokenRefused(err instanceof joseErrors.JOSEError ? err.code : 'unreadable token');
    }
    if (!String(payload.scope ?? '').split(' ').includes(PUBLISH_SCOPE)) throw new TokenRefused('ERR_SCOPE');
    // JWTs can't be revoked, so the grant behind each one is checked (R26).
    if (!(await deps.oidc.grantActive(String(payload.gid)))) throw new TokenRefused('ERR_GRANT_REVOKED');
    return { userId: String(payload.sub), clientId: String(payload.client_id) };
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    next();
  });

  // Tells clients where to get a token (RFC 9728), at both paths clients use.
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json({ resource: deps.resource, authorization_servers: [deps.issuer], scopes_supported: [PUBLISH_SCOPE], bearer_methods_supported: ['header'] });
  });

  // Inline publishes are base64 inside JSON, so the limit is a third above the
  // inline size, plus room for the rest of the request.
  const json = express.json({ limit: Math.ceil((deps.config.limits.inlinePublish * 4) / 3) + 256 * 1024 });

  app.post('/mcp', async (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const token = /^Bearer [A-Za-z0-9._~+/-]+=*$/.test(header) ? header.slice('Bearer '.length) : '';
    let caller: Verified;
    try {
      if (!token) throw new TokenRefused('no token');
      caller = await verify(token);
    } catch (err) {
      if (!(err instanceof TokenRefused)) return next(err);
      // A client's first request has no token; only failed tokens are events.
      if (token) await deps.events.record({ action: 'mcp.token', result: 'refused', ip: ipOf(req), detail: err.message });
      const scope = err.message === 'ERR_SCOPE';
      res.status(scope ? 403 : 401)
        .set('www-authenticate', `Bearer resource_metadata="${metadataUrl}"${scope ? `, error="insufficient_scope", scope="${PUBLISH_SCOPE}"` : token ? ', error="invalid_token"' : ''}`)
        .json({ error: scope ? 'insufficient_scope' : 'unauthorized' });
      return;
    }
    // Parsed only once the caller is known.
    json(req, res, async (parseError?: unknown) => {
      if (parseError) return next(parseError);
      try {
        const server = createServer(deps, { userId: caller.userId, ip: ipOf(req) }, deps.log);
        // No session ID generator means stateless mode.
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
        // The SDK's transport types don't satisfy exactOptionalPropertyTypes.
        await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        next(err);
      }
    });
  });

  // Stateless: no server-sent event streams or sessions to resume or end.
  app.all('/mcp', (_req, res) => {
    res.status(405).set('allow', 'POST').json({ error: 'method not allowed' });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) {
      res.status(status).json({ jsonrpc: '2.0', error: { code: -32700, message: status === 413 ? 'Request too large' : 'Parse error' }, id: null });
      return;
    }
    deps.log('request failed', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  });

  return app;
}
