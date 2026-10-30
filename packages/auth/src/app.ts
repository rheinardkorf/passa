// The auth. web app: sign-in pages, sessions, the site handoff, and the OAuth
// authorization server for MCP clients, all on one session.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isName, isSiteId, isSitePath } from '@passa/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import { CSRF_COOKIE, readCookies, SESSION_COOKIE } from './cookies.ts';
import { createProvider, type OAuthDeps } from './oauth.ts';
import {
  checkEmailPage,
  type ConnectedApp,
  connectedAppsPage,
  consentPage,
  CONTINUE_SCRIPT,
  continuePage,
  continuingPage,
  errorPage,
  interactionGonePage,
  invalidLinkPage,
  type Next,
  notPublisherPage,
  refusedPage,
  signedInPage,
  signedOutPage,
  signInPage,
  STYLES,
  type Target,
} from './pages.ts';
import { isInteractionUid, isPublisher, SignIn, type SignInDeps } from './signin.ts';

export type AuthDeps = SignInDeps & OAuthDeps & {
  // The viewer's IP. Behind CloudFront this comes from a trusted header.
  clientIp?: (req: Request) => string;
};

const setCookie = (res: Response, name: string, value: string, maxAge: number) =>
  res.append('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const field = (value: unknown) => (typeof value === 'string' ? value : '');

// The edge sends the host's label: a site ID, or a name (M2 R44), which
// sign-in resolves, so an unknown name looks just like a private site.
function parseTarget(site: unknown, path: unknown): Target | undefined {
  const siteId = field(site);
  const p = field(path);
  return (isSiteId(siteId) || isName(siteId)) && isSitePath(p) ? { siteId, path: p } : undefined;
}

function parseNext(body: Record<string, unknown>): Next | undefined {
  const site = parseTarget(body.site, body.path);
  if (site) return { site };
  const interaction = field(body.interaction);
  return isInteractionUid(interaction) ? { interaction } : undefined;
}

// Requests oidc-provider answers itself: authorization, tokens, keys,
// registration, revocation and its metadata.
const OIDC_PATHS = /^\/(auth|token|jwks|reg)(\/|$)|^\/\.well-known\/(openid-configuration|oauth-authorization-server)$/;

export function createAuthApp(deps: AuthDeps): express.Express {
  const signin = new SignIn(deps);
  const provider = createProvider(deps, signin);
  const oidc = provider.callback();
  const { urls } = signin;
  const { lifetimes } = deps.config;
  const ipOf = (req: Request) => (deps.clientIp ? deps.clientIp(req) : (req.socket.remoteAddress ?? ''));
  const app = express();
  app.disable('x-powered-by');

  // Forms post only to auth. itself. After a post, pages that lead elsewhere
  // move on with continuingPage rather than a redirect, so this can stay 'self'.
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');

  app.use((req, res, next) => {
    res.set({
      'content-security-policy': csp,
      'cache-control': 'no-store',
      'strict-transport-security': 'max-age=63072000; includeSubDomains',
      'x-content-type-options': 'nosniff',
      // Not no-referrer: under it, browsers send "Origin: null" on form posts,
      // which the origin check below would refuse. Other sites still get none.
      'referrer-policy': 'same-origin',
      'cross-origin-opener-policy': 'same-origin',
      'cross-origin-resource-policy': 'same-origin',
    });
    const cookies = readCookies(req.headers.cookie);
    res.locals.cookies = cookies;
    // Every form carries the CSRF cookie's value, compared on post (R20). The
    // __Host- prefix stops sibling hosts (sites included) from setting it.
    let csrf = cookies[CSRF_COOKIE] ?? '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(csrf)) {
      csrf = randomBytes(32).toString('base64url');
      setCookie(res, CSRF_COOKIE, csrf, lifetimes.sessionMax);
    }
    res.locals.csrf = csrf;
    next();
  });

  // oidc-provider parses its own request bodies, so this comes before any
  // body parser. Clients look for RFC 8414 metadata, which is the same document.
  app.use((req, res, next) => {
    if (!OIDC_PATHS.test(req.path)) return next();
    if (req.path === '/.well-known/oauth-authorization-server') req.url = '/.well-known/openid-configuration';
    oidc(req, res);
  });

  const form = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });
  // Refused posts are security events (R31); the reason never includes token values.
  const checkPost = async (req: Request, res: Response, next: NextFunction) => {
    const cookie = cookiesOf(res)[CSRF_COOKIE] ?? '';
    const origin = req.headers.origin;
    const reason = origin !== urls.auth ? `origin ${String(origin ?? 'missing').slice(0, 100)}`
      : !cookie ? 'no csrf cookie'
      : !sameSecret(field(req.body?.csrf), cookie) ? (field(req.body?.csrf) ? 'csrf mismatch' : 'no csrf field')
      : undefined;
    if (reason) {
      await event({ action: 'form.post', result: 'refused', ip: ipOf(req), detail: `${req.path}: ${reason}` });
      res.status(403).type('html').send(errorPage(403));
      return;
    }
    next();
  };

  const cookiesOf = (res: Response) => res.locals.cookies as Record<string, string>;
  const csrfOf = (res: Response) => res.locals.csrf as string;
  const html = (res: Response, body: string, status = 200) => res.status(status).type('html').send(body);
  const sessionOf = (res: Response) => signin.session(cookiesOf(res)[SESSION_COOKIE]);
  const event = (e: Parameters<typeof deps.events.record>[0]) => deps.events.record(e);

  app.get('/assets/auth.css', (_req, res) => {
    res.set('cache-control', 'public, max-age=3600').type('css').send(STYLES);
  });
  app.get('/assets/continue.js', (_req, res) => {
    res.set('cache-control', 'public, max-age=3600').type('js').send(CONTINUE_SCRIPT);
  });

  app.get('/', async (_req, res) => {
    const current = await sessionOf(res);
    html(res, current ? signedInPage({ csrf: csrfOf(res), email: current.user.email, publisher: isPublisher(current.user) }) : signInPage({ csrf: csrfOf(res) }));
  });

  // Where the edge sends visitors without a valid site cookie (R10). With a
  // session, this refreshes the site cookie without another email (R18).
  app.get('/site/signin', async (req, res) => {
    const target = parseTarget(req.query.site, req.query.path);
    if (!target) return html(res, errorPage(400), 400);
    const current = await sessionOf(res);
    if (!current) return html(res, signInPage({ csrf: csrfOf(res), next: { site: target } }));
    const location = await signin.siteRedirect(current.user, target, ipOf(req));
    if (!location) return html(res, refusedPage({ csrf: csrfOf(res), email: current.user.email, target }), 403);
    res.redirect(302, location);
  });

  app.post('/signin', form, checkPost, async (req, res) => {
    const email = field(req.body.email).trim();
    const next = parseNext(req.body);
    if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email)) {
      return html(res, signInPage({ csrf: csrfOf(res), error: 'Enter an email address.', next }), 400);
    }
    await signin.requestLink({ email, ip: ipOf(req), next });
    html(res, checkEmailPage(Math.round(lifetimes.magicLink / 60)));
  });

  // Opening the link only shows a button, so email scanners that follow links
  // don't use it up (R17). The token stays in the fragment until Continue.
  app.get('/signin/continue', (_req, res) => {
    html(res, continuePage(csrfOf(res)));
  });

  app.post('/signin/continue', form, checkPost, async (req, res) => {
    const result = await signin.continue({ token: field(req.body.token), ip: ipOf(req) });
    if (!result) return html(res, invalidLinkPage(), 400);
    // Whatever session this browser had before is ended, not reused (R18).
    const previous = cookiesOf(res)[SESSION_COOKIE];
    if (previous) await signin.endSession(previous, ipOf(req));
    setCookie(res, SESSION_COOKIE, result.sessionId, lifetimes.sessionMax);
    const next = result.next;
    const to = !next ? '/' : 'site' in next
      ? `/site/signin?${new URLSearchParams({ site: next.site.siteId, path: next.site.path })}`
      : `/interaction/${next.interaction}`;
    html(res, continuingPage(to));
  });

  app.post('/signout', form, checkPost, async (req, res) => {
    const sessionId = cookiesOf(res)[SESSION_COOKIE];
    if (sessionId) {
      const current = await signin.session(sessionId);
      await signin.endSession(sessionId, ipOf(req), current?.user.id);
    }
    setCookie(res, SESSION_COOKIE, '', 0);
    html(res, signedOutPage(Math.round(lifetimes.siteCookie / 60)));
  });

  // An app asking to connect (R24). oidc-provider sends the browser here when
  // it needs a sign-in or consent; the interaction cookie ties it to the request.
  const interaction = async (req: Request, res: Response) => {
    try {
      const details = await provider.interactionDetails(req, res);
      return details.uid === req.params.uid ? details : undefined;
    } catch {
      return undefined;
    }
  };

  app.get('/interaction/:uid', async (req, res) => {
    const details = await interaction(req, res);
    const current = await sessionOf(res);
    if (!details) return html(res, interactionGonePage(!!current), 400);
    const clientId = String(details.params.client_id);

    if (details.prompt.name === 'login') {
      if (!current) return html(res, signInPage({ csrf: csrfOf(res), next: { interaction: details.uid } }));
      // Only publishers may connect apps, and they're refused before consent.
      if (!isPublisher(current.user)) {
        await event({ action: 'oauth.consent', result: 'refused', userId: current.user.id, ip: ipOf(req), detail: `not a publisher (${clientId})` });
        const back = await provider.interactionResult(req, res, { error: 'access_denied', error_description: 'This account cannot publish.' });
        return html(res, notPublisherPage({ email: current.user.email, back }), 403);
      }
      const to = await provider.interactionResult(req, res, { login: { accountId: current.user.id } }, { mergeWithLastSubmission: false });
      return res.redirect(303, to);
    }

    if (details.prompt.name === 'consent' && current && current.user.id === details.session?.accountId) {
      const client = await provider.Client.find(clientId);
      return html(res, consentPage({
        csrf: csrfOf(res),
        uid: details.uid,
        email: current.user.email,
        clientName: client?.clientName,
        clientId,
        redirectHost: URL.parse(String(details.params.redirect_uri))?.host ?? '',
      }));
    }
    html(res, errorPage(400), 400);
  });

  app.post('/interaction/:uid/confirm', form, checkPost, async (req, res) => {
    const details = await interaction(req, res);
    const current = await sessionOf(res);
    if (!details) return html(res, interactionGonePage(!!current), 400);
    if (details.prompt.name !== 'consent' || !current || !isPublisher(current.user) || current.user.id !== details.session?.accountId) {
      const reason = details.prompt.name !== 'consent' ? `prompt ${details.prompt.name}` : !current ? 'no session' : !isPublisher(current.user) ? 'not a publisher' : 'session for another account';
      await event({ action: 'oauth.consent', result: 'refused', ip: ipOf(req), ...(current ? { userId: current.user.id } : {}), detail: reason });
      return html(res, errorPage(403), 403);
    }
    const missing = details.prompt.details as {
      missingOIDCScope?: string[];
      missingOIDCClaims?: string[];
      missingResourceScopes?: Record<string, string[]>;
    };
    const grant = (details.grantId ? await provider.Grant.find(details.grantId) : undefined)
      ?? new provider.Grant({ accountId: current.user.id, clientId: String(details.params.client_id) });
    if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
    if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims);
    for (const [indicator, scopes] of Object.entries(missing.missingResourceScopes ?? {})) grant.addResourceScope(indicator, scopes.join(' '));
    const grantId = await grant.save();
    await event({ action: 'oauth.consent', result: 'ok', userId: current.user.id, ip: ipOf(req), detail: String(details.params.client_id) });
    const to = await provider.interactionResult(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
    html(res, continuingPage(to));
  });

  app.post('/interaction/:uid/deny', form, checkPost, async (req, res) => {
    const details = await interaction(req, res);
    const current = await sessionOf(res);
    if (!details) return html(res, interactionGonePage(!!current), 400);
    await event({ action: 'oauth.consent', result: 'refused', ip: ipOf(req), detail: `denied (${String(details.params.client_id)})`, ...(current ? { userId: current.user.id } : {}) });
    const to = await provider.interactionResult(req, res, { error: 'access_denied', error_description: 'The user denied access.' }, { mergeWithLastSubmission: false });
    html(res, continuingPage(to));
  });

  // Connected apps (R29): the publisher's grants, each revocable at once.
  app.get('/apps', async (_req, res) => {
    const current = await sessionOf(res);
    if (!current || !isPublisher(current.user)) return res.redirect(303, '/');
    const apps: ConnectedApp[] = [];
    for (const grant of await deps.oidc.grantsForAccount(current.user.id)) {
      const client = await provider.Client.find(grant.clientId).catch(() => undefined);
      apps.push({ grantId: grant.id, name: client?.clientName ?? grant.clientId, clientId: grant.clientId, createdAt: grant.createdAt });
    }
    html(res, connectedAppsPage({ csrf: csrfOf(res), email: current.user.email, apps }));
  });

  app.post('/apps/revoke', form, checkPost, async (req, res) => {
    const current = await sessionOf(res);
    if (!current) return res.redirect(303, '/');
    const grantId = field(req.body.grant);
    const grant = (await deps.oidc.grantsForAccount(current.user.id)).find((g) => g.id === grantId);
    if (grant) {
      await deps.oidc.revokeGrant(grant.id);
      await event({ action: 'oauth.disconnect', result: 'ok', userId: current.user.id, ip: ipOf(req), detail: grant.clientId });
    }
    res.redirect(303, '/apps');
  });

  app.use((_req, res) => {
    html(res, errorPage(404), 404);
  });

  // Errors are generic: no stack traces or details in responses. Express
  // recognises error handlers by their four parameters.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status;
    if (status === 400 || status === 413) return html(res, errorPage(400), 400);
    deps.log?.('request failed', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
    if (!res.headersSent) html(res, errorPage(500), 500);
  });

  return app;
}
