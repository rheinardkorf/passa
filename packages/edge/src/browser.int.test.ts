// Sign-in in a real browser (the installed Chrome), through the local stack.
// Browsers enforce what plain HTTP tests can't: Origin headers, referrer
// policy, CSP (form-action, connect-src), __Host- cookies and meta refresh.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { addUser } from '@passa/mcp/testing';
import { type Browser, chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Stack, startStack } from './testing.ts';

let stack: Stack;
let browser: Browser;

beforeAll(async () => {
  stack = await startStack();
  await addUser(stack.env, { id: 'alice' });
  // PASSA_TEST_CHROME points at another Chromium-based browser if needed.
  browser = await chromium.launch(process.env.PASSA_TEST_CHROME ? { executablePath: process.env.PASSA_TEST_CHROME } : { channel: 'chrome' });
});

afterAll(async () => {
  await browser?.close();
  await stack?.close();
});

const linkFor = (email: string) => /(http:\/\/localhost:\d+\/signin\/continue#t=[A-Za-z0-9_-]+)/.exec(stack.sent.filter((e) => e.to === email).at(-1)?.text ?? '')?.[1] ?? '';

describe('in a real browser', () => {
  it('signs the owner in to a private site, where the CSP blocks outbound requests', async () => {
    const site = await stack.publisher.publish({ userId: 'alice' }, {
      title: 'Browser',
      content: {
        files: [{
          path: 'index.html',
          content: new TextEncoder().encode(`<!doctype html><h1>Hello</h1><p id="net">pending</p>
<script>fetch('https://example.com/').then(() => { net.textContent = 'sent'; }, () => { net.textContent = 'blocked'; });</script>`),
        }],
      },
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(site.url);
    expect(page.url()).toContain(`//localhost:${stack.port}/site/signin?site=${site.site_id}`);
    await page.fill('#email', 'alice@example.com');
    await page.click('button:has-text("Email me a link")');
    await page.waitForSelector('text=Check your email');

    await page.goto(linkFor('alice@example.com'));
    // The token has moved from the address bar into the form.
    expect(page.url()).not.toContain('#t=');
    await page.click('button:has-text("Continue")');
    await page.waitForURL(site.url);
    expect(await page.textContent('h1')).toBe('Hello');
    // Runs in the page; a string, since this project's TypeScript has no DOM types.
    await page.waitForFunction("document.getElementById('net').textContent !== 'pending'");
    expect(await page.textContent('#net')).toBe('blocked');
    await context.close();
  });

  it('connects an app: sign-in, consent, and back to the app with a code', async () => {
    const { port } = stack;
    const reg = (await (await fetch(`http://localhost:${port}/reg`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Browser Agent', redirect_uris: ['http://127.0.0.1/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    })).json()) as { client_id: string };
    // The app's own callback server on a random port, as Claude Code runs one.
    const app = createServer((_req, res) => res.end('app'));
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const callback = `http://127.0.0.1:${(app.address() as AddressInfo).port}/callback`;
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`http://localhost:${port}/auth?${new URLSearchParams({
      client_id: reg.client_id, redirect_uri: callback, response_type: 'code', scope: 'publish offline_access',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256',
      resource: `http://mcp.localhost:${port}/mcp`, state: 'b1',
    })}`);
    await page.waitForSelector('text=An app wants to publish as you');
    await page.fill('#email', 'alice@example.com');
    await page.click('button:has-text("Email me a link")');
    await page.waitForSelector('text=Check your email');
    await page.goto(linkFor('alice@example.com'));
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text=Browser Agent');
    expect(await page.textContent('.host')).toBe(new URL(callback).host);
    await page.click('button:has-text("Allow")');
    await page.waitForURL(`${callback}**`);
    const back = new URL(page.url());
    expect(back.searchParams.get('code')).toBeTruthy();
    expect(back.searchParams.get('state')).toBe('b1');
    await context.close();
    app.close();
  });
});
