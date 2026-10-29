// The OAuth 2.1 authorization server for MCP clients (R21–R28), built on
// oidc-provider. Its login step is a Passa sign-in: the auth. session decides
// who is signed in, and oidc-provider's own session only follows it.
import { isIP } from 'node:net';
import type { Config, Events, OidcStore, Store } from '@passa/shared';
import Provider, { errors, type ExternalSigningKey, interactionPolicy, type KoaContextWithOIDC } from 'oidc-provider';
import { readCookies, SESSION_COOKIE } from './cookies.ts';
import { errorPage } from './pages.ts';
import { isPublisher, type SignIn, type Urls } from './signin.ts';

export const PUBLISH_SCOPE = 'publish';
export const mcpResource = (urls: Pick<Urls, 'mcp'>) => `${urls.mcp}/mcp`;

export type OAuthDeps = {
  store: Store;
  events: Events;
  config: Config;
  oidc: OidcStore;
  // Signs access tokens; in AWS, a KmsSigningKey.
  tokenSigner: ExternalSigningKey;
  // Sign oidc-provider's cookies; the first signs, all verify.
  cookieKeys: string[];
  // Behind CloudFront, trust X-Forwarded-* for the request's scheme and host.
  trustProxy?: boolean;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

// Client ID metadata documents are fetched from the internet. oidc-provider
// enforces HTTPS, refuses special-use addresses after DNS resolution, follows no
// redirects, and limits time (2.5 s) and size (5 KB). This also refuses names
// that only make sense on a local network (R28).
const LOCAL_NAMES = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa)$/i;
export function allowClientIdUrl(clientId: string): boolean {
  const host = URL.parse(clientId)?.hostname ?? '';
  return host.includes('.') && !host.startsWith('[') && isIP(host) === 0 && !LOCAL_NAMES.test(host);
}

// RFC 8252: loopback redirects match on any port. oidc-provider only does this
// for native clients, and MCP clients such as Claude Code don't say they are (R25).
const isLoopback = (u: URL) => u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
const withoutPort = (u: URL) => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
export function loopbackMatches(registered: readonly string[], requested: string): boolean {
  const want = URL.parse(requested);
  if (!want || !isLoopback(want)) return false;
  return registered.some((allowed) => {
    const have = URL.parse(allowed);
    return !!have && isLoopback(have) && withoutPort(have) === withoutPort(want);
  });
}

export function createProvider(deps: OAuthDeps, signin: SignIn): Provider {
  const { config, store, events } = deps;
  const { lifetimes } = config;
  const resource = mcpResource(signin.urls);

  // Ask for a Passa sign-in unless there is a valid auth. session for the same
  // account oidc-provider remembers. A cookie set by a site can't change this.
  const policy = interactionPolicy.base();
  policy.get('login')?.checks.add(new interactionPolicy.Check('passa_session', 'a Passa sign-in is required', async (ctx: KoaContextWithOIDC) => {
    const current = await signin.session(readCookies(ctx.get('cookie'))[SESSION_COOKIE]);
    return !current || current.user.id !== ctx.oidc.session?.accountId
      ? interactionPolicy.Check.REQUEST_PROMPT
      : interactionPolicy.Check.NO_NEED_TO_PROMPT;
  }));

  const provider = new Provider(signin.urls.auth, {
    adapter: (model: string) => deps.oidc.adapter(model),
    clients: [],
    jwks: { keys: [deps.tokenSigner] },
    clientDefaults: { id_token_signed_response_alg: 'ES256' },
    // Public clients, or a client secret. No private_key_jwt, so a client's
    // jwks_uri is never fetched.
    clientAuthMethods: ['none', 'client_secret_basic', 'client_secret_post'],
    cookies: { keys: deps.cookieKeys },
    scopes: ['openid', 'offline_access', PUBLISH_SCOPE],
    claims: { openid: ['sub'] },
    // Tokens are only issued, and refreshed, for active publishers.
    findAccount: async (_ctx, sub) => {
      const user = await store.getUser(sub);
      return user && isPublisher(user) ? { accountId: sub, claims: async () => ({ sub }) } : undefined;
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}`, policy },
    pkce: { required: () => true },
    issueRefreshToken: async (_ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: true,
    ttl: {
      AccessToken: lifetimes.accessToken,
      RefreshToken: lifetimes.refreshToken,
      Grant: lifetimes.refreshToken,
      Session: lifetimes.sessionMax,
      Interaction: 3600,
      AuthorizationCode: 60,
    },
    // R26: access tokens carry their grant ID, so the MCP server can check the
    // grant still exists on every call.
    extraTokenClaims: async (_ctx, token) => ({ gid: (token as { grantId?: string }).grantId }),
    fetchResponseBodyLimits: { 'client_id metadata document': 5 * 1024, jwks_uri: 0, sector_identifier_uri: 0 },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      externalSigningSupport: { enabled: true, ack: 'experimental-01' },
      clientIdMetadataDocument: {
        enabled: true,
        ack: 'draft-02',
        allowFetch: async (_ctx, clientId) => allowClientIdUrl(clientId),
      },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => undefined as unknown as string,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, indicator) => {
          // R23: tokens are only for this deployment's MCP server.
          if (indicator !== resource) throw new errors.InvalidTarget();
          return {
            scope: PUBLISH_SCOPE,
            audience: resource,
            accessTokenTTL: lifetimes.accessToken,
            accessTokenFormat: 'jwt',
            jwt: { sign: { alg: 'ES256' } },
          };
        },
      },
    },
    // Errors are generic pages; the details go back to the client, not the screen.
    renderError: (ctx) => {
      ctx.type = 'html';
      ctx.body = errorPage(ctx.status >= 500 ? 500 : 400);
    },
  });
  provider.proxy = deps.trustProxy ?? false;

  const redirectUriAllowed = provider.Client.prototype.redirectUriAllowed;
  provider.Client.prototype.redirectUriAllowed = function (this: InstanceType<typeof provider.Client>, value: string) {
    return redirectUriAllowed.call(this, value) || loopbackMatches(this.redirectUris ?? [], value);
  };

  // Security events (R31). Messages are the library's generic error text,
  // never tokens.
  const record = (action: string) => (ctx: KoaContextWithOIDC, err: Error) => {
    const clientId = ctx.oidc?.client?.clientId;
    events.record({ action, result: 'refused', ip: ctx.ip, detail: `${err.message}${clientId ? ` (${clientId})` : ''}` })
      .catch((e: unknown) => deps.log?.('event failed', { error: String(e) }));
  };
  provider.on('authorization.error', record('oauth.authorize'));
  provider.on('grant.error', record('oauth.token'));
  provider.on('registration_create.error', record('oauth.register'));
  provider.on('revocation.error', record('oauth.revoke'));
  provider.on('grant.revoked', (ctx: KoaContextWithOIDC, grantId: string) => {
    events.record({ action: 'oauth.grant_revoked', result: 'ok', ip: ctx.ip, detail: grantId })
      .catch((e: unknown) => deps.log?.('event failed', { error: String(e) }));
  });
  provider.on('server_error', (_ctx: KoaContextWithOIDC, err: Error) => deps.log?.('oauth server error', { error: `${err.name}: ${err.message}` }));

  return provider;
}
