// The email sent when a site is shared (M5 R130) or someone is added to a
// tier (M6 R153): who did it, where the site is, and when access begins and
// ends. Never the site's title, a page title, the tier or a sign-in token (R142).
import type { Email } from '@passa/shared';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const day = (iso: string) => iso.slice(0, 10);

export function inviteEmail(input: { to: string; from: string; url: string; member?: boolean; startsAt?: string; expiresAt?: string }): Email {
  const what = input.member ? 'added you as a member of a site' : 'shared a site with you';
  const from = input.startsAt ? ` from ${day(input.startsAt)}` : '';
  const until = input.expiresAt ? ` until ${day(input.expiresAt)}` : '';
  const text = `${input.from} ${what}${from}${until}:

${input.url}

Open it and sign in with this email address (${input.to}). Passa sends you a sign-in link; there's no password.

If you weren't expecting this, you can ignore this email.
`;
  const html = `<!doctype html>
<html><body style="font:16px/1.5 system-ui,sans-serif">
<p>${esc(input.from)} ${what}${esc(from)}${esc(until)}:</p>
<p><a href="${esc(input.url)}">${esc(input.url)}</a></p>
<p>Open it and sign in with this email address (${esc(input.to)}). Passa sends you a sign-in link; there's no password.</p>
<p style="color:#5c5c5c">If you weren't expecting this, you can ignore this email.</p>
</body></html>
`;
  return { to: input.to, subject: `${input.from} ${what}`, text, html };
}
