// Sign-in end to end against Moto: real magic-link emails through SES, read
// back from Moto, and a small cookie-keeping client standing in for a browser.
import { randomBytes } from 'node:crypto';
import type { AddressInfo, Server } from 'node:net';
import { CreateEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { addUser, type TestEnv, testEnv } from '@passa/mcp/testing';
import { newSiteId, newVersionId, type User } from '@passa/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthApp } from './app.ts';
import { type Email, SesMailer } from './mailer.ts';
import { errorPage } from './pages.ts';
import { authTestDeps } from './testing.ts';

const endpoint = process.env.PASSA_TEST_AWS_ENDPOINT ?? 'http://127.0.0.1:5005';
const AUTH = 'https://auth.example.com';

let env: TestEnv;
let server: Server;
let base: string;
let clock = Date.now();
// Every email that SES (Moto) accepted, newest last.
let sent: Email[] = [];

beforeAll(async () => {
  env = await testEnv();
  const ses = new SESv2Client({ endpoint, region: 'ap-southeast-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: 'example.com' }));
  const deps = await authTestDeps(
    env,
    { auth: AUTH, mcp: 'https://mcp.example.com', site: (id) => `https://${id}.example.com` },
    { mailer: new SesMailer(ses, env.config.email.from), now: () => new Date(clock) },
  );
  sent = deps.sent;
  const app = createAuthApp(deps);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Reply = { status: number; location: string; body: string; cookies: string[] };

// Keeps cookies and sends the Origin and CSRF token a browser form would.
class Browser {
  cookies = new Map<string, string>();

  async request(path: string, init: { method?: string; form?: Record<string, string>; origin?: string | null; csrf?: string | null } = {}): Promise<Reply> {
    const headers: Record<string, string> = { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
    let body: string | undefined;
    if (init.form) {
      if (init.origin !== null) headers.origin = init.origin ?? AUTH;
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const csrf = init.csrf === undefined ? this.cookies.get('__Host-passa-csrf') : init.csrf;
      body = new URLSearchParams({ ...init.form, ...(csrf === null || csrf === undefined ? {} : { csrf }) }).toString();
    }
    const res = await fetch(`${base}${path}`, { method: init.method ?? (init.form ? 'POST' : 'GET'), headers, redirect: 'manual', ...(body ? { body } : {}) });
    const cookies = res.headers.getSetCookie();
    for (const c of cookies) {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1);
      if (/Max-Age=0\b/.test(c) || value === '') this.cookies.delete(pair.slice(0, eq));
      else this.cookies.set(pair.slice(0, eq), value);
    }
    return { status: res.status, location: res.headers.get('location') ?? '', body: await res.text(), cookies };
  }

  // Loads a page first, as a browser would, so the CSRF cookie exists.
  async post(path: string, form: Record<string, string>, init: { origin?: string | null; csrf?: string | null } = {}): Promise<Reply> {
    if (!this.cookies.has('__Host-passa-csrf')) await this.request('/');
    return this.request(path, { form, ...init });
  }
}

// What Moto's SES holds for an address. Slow (it dumps all of Moto's state),
// so most tests use the record above instead.
async function motoEmails(to: string): Promise<{ subject: string; body: string }[]> {
  type Message = { destinations: { ToAddresses: string[] }; subject: string; body: string };
  const data = (await (await fetch(`${endpoint}/moto-api/data.json`)).json()) as { ses: { Message: Message[] } };
  return data.ses.Message.filter((m) => m.destinations.ToAddresses.includes(to));
}

// Where a continuingPage moves on to.
function refreshTo(body: string): string {
  const url = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(body)?.[1] ?? '';
  return url.replaceAll('&amp;', '&');
}

const emailsTo = (to: string) => sent.filter((e) => e.to === to).length;

function tokenFor(to: string): string {
  const body = sent.filter((e) => e.to === to).at(-1)?.text ?? '';
  const match = /https:\/\/auth\.example\.com\/signin\/continue#t=([A-Za-z0-9_-]{43})/.exec(body);
  if (!match?.[1]) throw new Error(`no sign-in link for ${to}`);
  return match[1];
}

async function newUser(): Promise<User> {
  const id = `u${randomBytes(4).toString('hex')}`;
  return addUser(env, { id, email: `${id}@example.com` });
}

async function newSite(ownerId: string): Promise<string> {
  const id = newSiteId();
  const now = new Date().toISOString();
  const version = newVersionId();
  await env.store.createSite(
    { id, ownerId, title: 'Secret plans', current: version, accessVersion: 1, status: 'active', createdAt: now, updatedAt: now },
    { id: version, siteId: id, files: [], size: 0, createdAt: now, createdBy: ownerId },
  );
  return id;
}

async function signIn(browser: Browser, user: User, target?: { siteId: string; path: string }): Promise<Reply> {
  await browser.post('/signin', { email: user.email, ...(target ? { site: target.siteId, path: target.path } : {}) });
  return browser.post('/signin/continue', { token: tokenFor(user.email) });
}

async function events(action: string): Promise<Record<string, unknown>[]> {
  const day = new Date(clock).toISOString().slice(0, 10);
  const { Items = [] } = await env.db.send(new QueryCommand({ TableName: env.tables.events, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': `DAY#${day}` } }));
  return Items.filter((e) => e.action === action);
}

describe('signing in to view a site', () => {
  it('emails the owner a link, and Continue hands them to the site (R10, R11, R15–R18)', async () => {
    const owner = await newUser();
    const siteId = await newSite(owner.id);
    const browser = new Browser();

    const form = await browser.request(`/site/signin?site=${siteId}&path=%2Fdocs%2F`);
    expect(form.status).toBe(200);
    expect(form.body).toContain(`name="site" value="${siteId}"`);
    expect(form.body).not.toContain('Secret plans');

    const sent = await browser.post('/signin', { email: owner.email.toUpperCase(), site: siteId, path: '/docs/' });
    expect(sent.body).toContain('If that address has access');
    const token = tokenFor(owner.email);
    // It really went through SES.
    const [email] = await motoEmails(owner.email);
    expect(email?.subject).toBe('Your sign-in link');
    expect(email?.body).toContain(`/signin/continue#t=${token}`);

    // Opening the link doesn't use it; only Continue does (R17).
    const page = await browser.request('/signin/continue');
    expect(page.body).toContain('<button>Continue</button>');
    expect(page.body).not.toContain(token);

    const done = await browser.post('/signin/continue', { token });
    expect(done.status).toBe(200);
    expect(refreshTo(done.body)).toBe(`/site/signin?site=${siteId}&path=%2Fdocs%2F`);
    expect(done.cookies.find((c) => c.startsWith('__Host-passa-session='))).toMatch(/^__Host-passa-session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax$/);

    const handoff = await browser.request(refreshTo(done.body));
    expect(handoff.status).toBe(302);
    const url = new URL(handoff.location);
    expect(`${url.origin}${url.pathname}`).toBe(`https://${siteId}.example.com/_passa/session`);
    expect(url.searchParams.get('p')).toBe('/docs/');
    expect(url.searchParams.get('l')).toBe('3600');
    expect(url.searchParams.get('t')).toMatch(new RegExp(`^k1\\.${siteId}\\.1\\.\\d+\\.[0-9a-f]{64}$`));

    expect((await events('signin.continue')).some((e) => e.userId === owner.id && e.result === 'ok')).toBe(true);
  });

  it('refreshes site cookies from the session without another email (R18)', async () => {
    const owner = await newUser();
    const [first, second] = [await newSite(owner.id), await newSite(owner.id)];
    const browser = new Browser();
    await signIn(browser, owner, { siteId: first, path: '/' });
    const before = emailsTo(owner.email);
    const r = await browser.request(`/site/signin?site=${second}&path=%2F`);
    expect(r.status).toBe(302);
    expect(r.location).toContain(`https://${second}.example.com/_passa/session?`);
    expect(emailsTo(owner.email)).toBe(before);
  });

  it('gives everyone the same response, and only emails people with access (R15)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const siteId = await newSite(owner.id);
    const replies = [];
    for (const email of [owner.email, other.email, 'nobody@example.com']) {
      replies.push((await new Browser().post('/signin', { email, site: siteId, path: '/' })).body);
    }
    expect(new Set(replies).size).toBe(1);
    expect(emailsTo(owner.email)).toBe(1);
    expect(emailsTo(other.email)).toBe(0);
    expect(emailsTo('nobody@example.com')).toBe(0);
  });

  it('refuses signed-in people without access, revealing nothing about the site (R12)', async () => {
    const owner = await newUser();
    const other = await newUser();
    const siteId = await newSite(owner.id);
    const browser = new Browser();
    await signIn(browser, other);
    const refused = await browser.request(`/site/signin?site=${siteId}&path=%2F`);
    const missing = await browser.request(`/site/signin?site=${newSiteId()}&path=%2F`);
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('Secret plans');
    expect(refused.body.replace(siteId, 'X')).toBe(missing.body.replace(/name="site" value="[a-z2-9-]+"/, `name="site" value="X"`));
    expect((await events('site.view')).some((e) => e.userId === other.id && e.siteId === siteId && e.result === 'refused')).toBe(true);
  });

  it('resolves names: the current one hands back to the name, anything else is refused (M2 R45)', async () => {
    const user = await newUser();
    const siteId = await newSite(user.id);
    const now = new Date(clock).toISOString();
    const hold = new Date(clock + 86_400_000).toISOString();
    await env.store.setName({ ownerId: user.id, siteId, to: 'held-one', now, holdUntil: hold });
    await env.store.setName({ ownerId: user.id, siteId, from: 'held-one', to: 'current-one', now, holdUntil: hold });
    // A site stored under a label that's a name, not an ID (like M1's IDs now).
    const legacy = 'hzfb9wff2xyk';
    await env.store.createSite(
      { id: legacy, ownerId: user.id, title: 'Old', current: newVersionId(), accessVersion: 1, status: 'active', createdAt: now, updatedAt: now },
      { id: newVersionId(), siteId: legacy, files: [], size: 0, createdAt: now, createdBy: user.id },
    );
    const browser = new Browser();
    await signIn(browser, user);

    for (const label of [siteId, 'current-one']) {
      const r = await browser.request(`/site/signin?site=${label}&path=%2F`);
      expect(r.status, label).toBe(302);
      expect(new URL(r.location).host, label).toBe('current-one.example.com');
    }
    for (const label of ['held-one', legacy, 'never-named']) expect((await browser.request(`/site/signin?site=${label}&path=%2F`)).status, label).toBe(403);
  });

  it('rejects site and path values the edge would never send', async () => {
    const browser = new Browser();
    for (const query of ['site=no--pe&path=%2F', 'site=Nope&path=%2F', 'site=a&path=%2F', `site=${newSiteId()}&path=%2F%2Fevil.example`, `site=${newSiteId()}&path=x`, `site=${newSiteId()}`]) {
      expect((await browser.request(`/site/signin?${query}`)).status, query).toBe(400);
    }
  });
});

describe('magic links', () => {
  it('work once (R16)', async () => {
    const user = await newUser();
    const browser = new Browser();
    await browser.post('/signin', { email: user.email });
    const token = tokenFor(user.email);
    expect((await browser.post('/signin/continue', { token })).status).toBe(200);
    const again = await new Browser().post('/signin/continue', { token });
    expect(again.status).toBe(400);
    expect(again.body).toContain('expired or has already been used');
  });

  it('expire (R16)', async () => {
    const user = await newUser();
    const browser = new Browser();
    await browser.post('/signin', { email: user.email });
    clock += (env.config.lifetimes.magicLink + 1) * 1000;
    try {
      expect((await browser.post('/signin/continue', { token: tokenFor(user.email) })).status).toBe(400);
    } finally {
      clock = Date.now();
    }
  });

  it('are stored only as a hash (R16)', async () => {
    const user = await newUser();
    await new Browser().post('/signin', { email: user.email });
    const token = tokenFor(user.email);
    const { Items = [] } = await env.db.send(new QueryCommand({
      TableName: env.tables.main,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: { ':pk': `TOKEN#${token}`, ':sk': 'META' },
    }));
    expect(Items).toEqual([]);
  });

  it('stop being sent past the per-email rate limit, with the same response (R20)', async () => {
    const user = await newUser();
    const replies = new Set<string>();
    for (let i = 0; i < env.config.rateLimits.signinPerEmail + 2; i++) replies.add((await new Browser().post('/signin', { email: user.email })).body);
    expect(replies.size).toBe(1);
    expect(emailsTo(user.email)).toBe(env.config.rateLimits.signinPerEmail);
    expect((await events('signin.request')).some((e) => e.email === user.email && e.detail === 'rate limited')).toBe(true);
  });
});

describe('sessions', () => {
  it('get a new ID at sign-in, ending any session the browser had (R18)', async () => {
    const user = await newUser();
    const browser = new Browser();
    await signIn(browser, user);
    const first = browser.cookies.get('__Host-passa-session');
    await signIn(browser, user);
    const second = browser.cookies.get('__Host-passa-session');
    expect(second).not.toBe(first);
    const stale = new Browser();
    stale.cookies.set('__Host-passa-session', first ?? '');
    expect((await stale.request('/')).body).toContain('Enter your email');
  });

  it('end at sign-out (R19)', async () => {
    const user = await newUser();
    const browser = new Browser();
    await signIn(browser, user);
    const id = browser.cookies.get('__Host-passa-session') ?? '';
    expect((await browser.request('/')).body).toContain(user.email);
    const out = await browser.post('/signout', {});
    expect(out.body).toContain('signed out');
    expect(out.cookies).toContain('__Host-passa-session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax');
    // The old ID is gone on the server too, not just from the browser.
    const replay = new Browser();
    replay.cookies.set('__Host-passa-session', id);
    expect((await replay.request('/')).body).toContain('Enter your email');
    expect((await events('signout')).some((e) => e.userId === user.id)).toBe(true);
  });

  it('expire when idle, and at their maximum lifetime even when used (R18)', async () => {
    const { sessionIdle, sessionMax } = env.config.lifetimes;
    const user = await newUser();
    const browser = new Browser();
    const start = clock;
    await signIn(browser, user);
    try {
      // Used every few days, it outlives the idle timeout...
      const step = Math.floor(sessionIdle / 2) * 1000;
      while (clock + step < start + sessionMax * 1000) {
        clock += step;
        expect((await browser.request('/')).body).toContain(user.email);
      }
      // ...but not its maximum lifetime.
      clock = start + sessionMax * 1000;
      expect((await browser.request('/')).body).toContain('Enter your email');

      const idle = new Browser();
      clock = Date.now();
      await signIn(idle, user);
      clock += (sessionIdle + 1) * 1000;
      expect((await idle.request('/')).body).toContain('Enter your email');
    } finally {
      clock = Date.now();
    }
  });

  it('stop working when the user is disabled', async () => {
    const user = await newUser();
    const browser = new Browser();
    await signIn(browser, user);
    await env.store.putUser({ ...user, status: 'disabled' });
    expect((await browser.request('/')).body).toContain('Enter your email');
  });
});

describe('forms and responses', () => {
  it('refuse posts without the CSRF token or from another origin (R20)', async () => {
    const user = await newUser();
    const browser = new Browser();
    const cases = [
      await browser.post('/signin', { email: user.email }, { csrf: null }),
      await browser.post('/signin', { email: user.email }, { csrf: 'x'.repeat(43) }),
      await browser.post('/signin', { email: user.email }, { origin: `https://${newSiteId()}.example.com` }),
      await browser.post('/signin', { email: user.email }, { origin: null }),
    ];
    for (const r of cases) expect(r.status).toBe(403);
    expect(emailsTo(user.email)).toBe(0);
    // Each is a security event with its reason, never the token.
    const details = (await events('form.post')).filter((e) => e.result === 'refused').map((e) => String(e.detail));
    for (const reason of ['/signin: no csrf field', '/signin: csrf mismatch', '/signin: origin https://', '/signin: origin missing']) {
      expect(details.some((d) => d.startsWith(reason)), reason).toBe(true);
    }
  });

  it('send strict security headers and host-only cookies', async () => {
    const r = await fetch(`${base}/`);
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    expect(r.headers.get('cache-control')).toBe('no-store');
    // Browsers only send a real Origin on form posts when this allows it.
    expect(r.headers.get('referrer-policy')).toBe('same-origin');
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-passa-csrf=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/);
  });

  it('answer unknown paths and oversized posts generically', async () => {
    const browser = new Browser();
    expect((await browser.request('/nope')).status).toBe(404);
    const big = await browser.post('/signin', { email: 'a@example.com', pad: 'x'.repeat(10_000) });
    expect(big.status).toBe(400);
    expect(big.body).toBe(errorPage(400));
  });
});
