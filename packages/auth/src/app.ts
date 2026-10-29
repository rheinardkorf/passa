// The auth. web app: sign-in pages, sessions and the site handoff. Step 6 adds
// the OAuth authorization server to this app, using the same session.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isSiteId, isSitePath } from '@passa/shared';
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  checkEmailPage,
  CONTINUE_SCRIPT,
  continuePage,
  errorPage,
  invalidLinkPage,
  refusedPage,
  signedInPage,
  signedOutPage,
  signInPage,
  STYLES,
  type Target,
} from './pages.ts';
import { SignIn, type SignInDeps } from './signin.ts';

export type AuthDeps = SignInDeps & {
  // The viewer's IP. Behind CloudFront this comes from a trusted header.
  clientIp?: (req: Request) => string;
  log?: (message: string, data?: Record<string, unknown>) => void;
};

// Host-only cookies by construction: __Host- requires Secure, Path=/ and no Domain.
const SESSION_COOKIE = '__Host-passa-session';
const CSRF_COOKIE = '__Host-passa-csrf';

function readCookies(req: Request): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}

const setCookie = (res: Response, name: string, value: string, maxAge: number) =>
  res.append('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const field = (value: unknown) => (typeof value === 'string' ? value : '');

function parseTarget(site: unknown, path: unknown): Target | undefined {
  const siteId = field(site);
  const p = field(path);
  return isSiteId(siteId) && isSitePath(p) ? { siteId, path: p } : undefined;
}

export function createAuthApp(deps: AuthDeps): express.Express {
  const signin = new SignIn(deps);
  const { urls } = signin;
  const { lifetimes } = deps.config;
  const ipOf = (req: Request) => (deps.clientIp ? deps.clientIp(req) : (req.socket.remoteAddress ?? ''));
  const app = express();
  app.disable('x-powered-by');

  // Forms may post only to auth. itself, and redirects after a post may go on
  // to a site's handoff URL, which browsers check against form-action too.
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `form-action 'self' ${urls.site('*')}`,
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
    const cookies = readCookies(req);
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

  const form = express.urlencoded({ extended: false, limit: '4kb', parameterLimit: 10 });
  const checkPost = (req: Request, res: Response, next: NextFunction) => {
    const cookie = (res.locals.cookies as Record<string, string>)[CSRF_COOKIE] ?? '';
    const ok = req.headers.origin === urls.auth && cookie !== '' && sameSecret(field(req.body?.csrf), cookie);
    if (!ok) {
      res.status(403).type('html').send(errorPage(403));
      return;
    }
    next();
  };

  const html = (res: Response, body: string, status = 200) => res.status(status).type('html').send(body);
  const sessionOf = (res: Response) => signin.session((res.locals.cookies as Record<string, string>)[SESSION_COOKIE]);

  app.get('/assets/auth.css', (_req, res) => {
    res.set('cache-control', 'public, max-age=3600').type('css').send(STYLES);
  });
  app.get('/assets/continue.js', (_req, res) => {
    res.set('cache-control', 'public, max-age=3600').type('js').send(CONTINUE_SCRIPT);
  });

  app.get('/', async (_req, res) => {
    const current = await sessionOf(res);
    const csrf = res.locals.csrf as string;
    html(res, current ? signedInPage({ csrf, email: current.user.email }) : signInPage({ csrf }));
  });

  // Where the edge sends visitors without a valid site cookie (R10). With a
  // session, this refreshes the site cookie without another email (R18).
  app.get('/site/signin', async (req, res) => {
    const target = parseTarget(req.query.site, req.query.path);
    if (!target) return html(res, errorPage(400), 400);
    const csrf = res.locals.csrf as string;
    const current = await sessionOf(res);
    if (!current) return html(res, signInPage({ csrf, target }));
    const location = await signin.siteRedirect(current.user, target, ipOf(req));
    if (!location) return html(res, refusedPage({ csrf, email: current.user.email, target }), 403);
    res.redirect(302, location);
  });

  app.post('/signin', form, checkPost, async (req, res) => {
    const email = field(req.body.email).trim();
    const target = parseTarget(req.body.site, req.body.path);
    if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(email)) {
      return html(res, signInPage({ csrf: res.locals.csrf as string, error: 'Enter an email address.', ...(target ? { target } : {}) }), 400);
    }
    await signin.requestLink({ email, ip: ipOf(req), target });
    html(res, checkEmailPage(Math.round(lifetimes.magicLink / 60)));
  });

  // Opening the link only shows a button, so email scanners that follow links
  // don't use it up (R17). The token stays in the fragment until Continue.
  app.get('/signin/continue', (_req, res) => {
    html(res, continuePage(res.locals.csrf as string));
  });

  app.post('/signin/continue', form, checkPost, async (req, res) => {
    const result = await signin.continue({ token: field(req.body.token), ip: ipOf(req) });
    if (!result) return html(res, invalidLinkPage(), 400);
    // Whatever session this browser had before is ended, not reused (R18).
    const previous = (res.locals.cookies as Record<string, string>)[SESSION_COOKIE];
    if (previous) await signin.endSession(previous, ipOf(req));
    setCookie(res, SESSION_COOKIE, result.sessionId, lifetimes.sessionMax);
    const next = result.target ? `/site/signin?${new URLSearchParams({ site: result.target.siteId, path: result.target.path })}` : '/';
    res.redirect(303, next);
  });

  app.post('/signout', form, checkPost, async (req, res) => {
    const sessionId = (res.locals.cookies as Record<string, string>)[SESSION_COOKIE];
    if (sessionId) {
      const current = await signin.session(sessionId);
      await signin.endSession(sessionId, ipOf(req), current?.user.id);
    }
    setCookie(res, SESSION_COOKIE, '', 0);
    html(res, signedOutPage(Math.round(lifetimes.siteCookie / 60)));
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
