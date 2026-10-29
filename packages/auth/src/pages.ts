// The pages auth. renders. Every value is escaped; pages load only the
// stylesheet and script below, under a CSP that allows nothing else.

export const STYLES = `
:root { color-scheme: light dark; --fg: #1a1a1a; --muted: #5c5c5c; --bg: #fff; --line: #d9d9d9; --accent: #1f5fd6; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececec; --muted: #a3a3a3; --bg: #161616; --line: #3a3a3a; --accent: #7aa7ff; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 26rem; margin: 15vh auto 4rem; padding: 0 1rem; }
h1 { font-size: 1.4rem; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); font-size: .9rem; }
.error { color: #c62828; }
label { display: block; margin-bottom: .25rem; }
input[type=email] { width: 100%; padding: .6rem; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; margin-bottom: 1rem; }
button { font: inherit; padding: .6rem 1rem; border: 0; border-radius: 6px; background: var(--accent); color: #fff; cursor: pointer; }
button.link { background: none; color: var(--accent); padding: 0; text-decoration: underline; }
button.secondary { background: none; color: var(--fg); border: 1px solid var(--line); margin-left: .5rem; }
.host { font-size: 1.3rem; font-weight: 600; word-break: break-all; }
ul.apps { list-style: none; padding: 0; }
ul.apps li { padding: .75rem 0; border-bottom: 1px solid var(--line); }
form.inline { display: inline; }
`;

// Moves the magic-link token from the URL fragment into the form, then removes
// it from the address bar and history. The fragment never reaches a server.
export const CONTINUE_SCRIPT = `
var token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
document.getElementById('token').value = token;
history.replaceState(null, '', location.pathname);
if (!token) {
  document.getElementById('continue').hidden = true;
  document.getElementById('missing').hidden = false;
}
`;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: string) => value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function layout(title: string, body: string, script = '', head = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
<main>
<h1>${esc(title)}</h1>
${body}
</main>
${script ? `<script src="${script}"></script>` : ''}
</body>
</html>
`;
}

const csrfField = (csrf: string) => `<input type="hidden" name="csrf" value="${esc(csrf)}">`;

export type Target = { siteId: string; path: string };
// Where a sign-in continues: a site, or an app asking to connect (OAuth).
export type Next = { site: Target } | { interaction: string };

const targetFields = (target?: Target) =>
  target ? `<input type="hidden" name="site" value="${esc(target.siteId)}"><input type="hidden" name="path" value="${esc(target.path)}">` : '';

const nextFields = (next?: Next) => {
  if (!next) return '';
  return 'site' in next ? targetFields(next.site) : `<input type="hidden" name="interaction" value="${esc(next.interaction)}">`;
};

export function signInPage(input: { csrf: string; next?: Next | undefined; error?: string }): string {
  const lead = !input.next ? '' : 'site' in input.next ? 'This page is private. ' : 'An app wants to publish as you. ';
  return layout('Sign in', `
<p>${lead}Enter your email and we'll send you a sign-in link.</p>
${input.error ? `<p class="error">${esc(input.error)}</p>` : ''}
<form method="post" action="/signin">
${csrfField(input.csrf)}${nextFields(input.next)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="email" required autofocus>
<button>Email me a link</button>
</form>`);
}

export function checkEmailPage(minutes: number): string {
  return layout('Check your email', `
<p>If that address has access, a sign-in link is on its way. It works once, for ${minutes} minutes.</p>
<p class="muted">Nothing arrived? Check your spam folder, or go back and try again.</p>`);
}

export function continuePage(csrf: string): string {
  return layout('Continue signing in', `
<form id="continue" method="post" action="/signin/continue">
${csrfField(csrf)}
<input type="hidden" name="token" id="token">
<button>Continue</button>
</form>
<p id="missing" class="error" hidden>This link is incomplete. Copy the whole link from the email, or request a new one.</p>
<noscript><p class="error">Turn on JavaScript to finish signing in.</p></noscript>`, '/assets/continue.js');
}

export function invalidLinkPage(): string {
  return layout('Link not valid', `
<p>This sign-in link has expired or has already been used.</p>
<p><a href="/">Request a new link</a></p>`);
}

const signOutForm = (csrf: string) => `<form class="inline" method="post" action="/signout">${csrfField(csrf)}<button class="link">Sign out</button></form>`;

// Says nothing about the site: not its title, and not whether it exists (R12).
export function refusedPage(input: { csrf: string; email: string; target: Target }): string {
  return layout('No access', `
<p>You're signed in as <strong>${esc(input.email)}</strong>, which doesn't have access to this page.</p>
<form method="post" action="/signin">
${csrfField(input.csrf)}${targetFields(input.target)}
<label for="email">Sign in with a different email</label>
<input id="email" name="email" type="email" autocomplete="email" required>
<button>Email me a link</button>
</form>
<p class="muted">${signOutForm(input.csrf)}</p>`);
}

export function signedInPage(input: { csrf: string; email: string; publisher: boolean }): string {
  return layout('Signed in', `
<p>You're signed in as <strong>${esc(input.email)}</strong>.</p>
${input.publisher ? '<p><a href="/apps">Connected apps</a></p>' : ''}
<p>${signOutForm(input.csrf)}</p>`);
}

// Moves on by itself. Used after a form post instead of a redirect, because
// browsers check every redirect after a post against the CSP's form-action,
// and the last one may go to an app's own address.
export function continuingPage(url: string): string {
  return layout('Continuing…', `
<p><a href="${esc(url)}">Continue</a></p>`, '', `\n<meta http-equiv="refresh" content="0;url=${esc(url)}">`);
}

// The consent screen (R24): who is asking, and above all where it sends you.
export function consentPage(input: { csrf: string; uid: string; email: string; clientName?: string | undefined; clientId: string; redirectHost: string }): string {
  const name = input.clientName ? esc(input.clientName) : 'An app without a name';
  return layout('Connect an app?', `
<p><strong>${name}</strong> wants to publish, update and delete sites as <strong>${esc(input.email)}</strong>.</p>
<p>After you answer, you'll be sent to:</p>
<p class="host">${esc(input.redirectHost)}</p>
<p class="muted">Only allow this if you were connecting an app at ${esc(input.redirectHost)} just now. App ID: ${esc(input.clientId)}</p>
<form class="inline" method="post" action="/interaction/${esc(input.uid)}/confirm">${csrfField(input.csrf)}<button>Allow</button></form>
<form class="inline" method="post" action="/interaction/${esc(input.uid)}/deny">${csrfField(input.csrf)}<button class="secondary">Deny</button></form>`);
}

export function notPublisherPage(input: { email: string; back: string }): string {
  return layout("Can't connect", `
<p><strong>${esc(input.email)}</strong> can't publish, so it can't connect apps.</p>
<p><a href="${esc(input.back)}">Back to the app</a></p>`);
}

// The connection request this browser started is gone: it expired, or the
// magic link was opened in a different browser.
export function interactionGonePage(signedIn: boolean): string {
  return layout('Start again', `
<p>${signedIn ? "You're signed in, but this browser didn't start connecting the app, or it took too long. " : 'This request took too long. '}Go back to the app and connect again.</p>`);
}

export type ConnectedApp = { grantId: string; name: string; clientId: string; createdAt?: string | undefined };

export function connectedAppsPage(input: { csrf: string; email: string; apps: ConnectedApp[] }): string {
  const rows = input.apps.map((app) => `
<li><strong>${esc(app.name)}</strong><br><span class="muted">${esc(app.clientId)}${app.createdAt ? ` · connected ${esc(app.createdAt.slice(0, 10))}` : ''}</span>
<form method="post" action="/apps/revoke">${csrfField(input.csrf)}<input type="hidden" name="grant" value="${esc(app.grantId)}"><button class="link">Disconnect</button></form></li>`).join('');
  return layout('Connected apps', `
<p>Apps that can publish as <strong>${esc(input.email)}</strong>. Disconnecting one stops it at once.</p>
${input.apps.length ? `<ul class="apps">${rows}</ul>` : '<p class="muted">No apps are connected.</p>'}
<p><a href="/">Back</a></p>`);
}

// Site cookies can't be revoked at the edge, so they lapse on their own (R19).
export function signedOutPage(siteCookieMinutes: number): string {
  return layout('Signed out', `
<p>You're signed out. Pages you had open stay available for up to ${siteCookieMinutes} minutes.</p>
<p><a href="/">Sign in again</a></p>`);
}

const ERRORS: Record<number, [string, string]> = {
  400: ['Something is missing', "That request wasn't complete. Go back and try again."],
  403: ['Not allowed', 'This request was refused. Go back, reload the page and try again.'],
  404: ['Not found', "There's nothing here."],
  500: ['Something went wrong', 'Try again in a moment.'],
};

export function errorPage(status: number): string {
  const [title, text] = ERRORS[status] ?? ERRORS[500] ?? ['Error', ''];
  return layout(title, `<p>${esc(text)}</p>`);
}

export function magicLinkEmail(input: { link: string; minutes: number }): { subject: string; text: string; html: string } {
  const text = `Use this link to sign in. It works once, for ${input.minutes} minutes:

${input.link}

If you didn't ask to sign in, you can ignore this email.
`;
  const html = `<!doctype html>
<html><body style="font:16px/1.5 system-ui,sans-serif">
<p>Use this link to sign in. It works once, for ${input.minutes} minutes:</p>
<p><a href="${esc(input.link)}">Sign in</a></p>
<p style="color:#5c5c5c">If you didn't ask to sign in, you can ignore this email.</p>
</body></html>
`;
  return { subject: 'Your sign-in link', text, html };
}
