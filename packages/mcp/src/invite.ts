// The email sent when a site is shared (M5 R130): who shared it and where it
// is. Never the site's title, a page title or a sign-in token (R142).
import type { Email } from '@passa/shared';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function inviteEmail(input: { to: string; from: string; url: string; expiresAt?: string }): Email {
  const until = input.expiresAt ? ` until ${input.expiresAt.slice(0, 10)}` : '';
  const text = `${input.from} shared a site with you${until}:

${input.url}

Open it and sign in with this email address (${input.to}). Passa sends you a sign-in link; there's no password.

If you weren't expecting this, you can ignore this email.
`;
  const html = `<!doctype html>
<html><body style="font:16px/1.5 system-ui,sans-serif">
<p>${esc(input.from)} shared a site with you${esc(until)}:</p>
<p><a href="${esc(input.url)}">${esc(input.url)}</a></p>
<p>Open it and sign in with this email address (${esc(input.to)}). Passa sends you a sign-in link; there's no password.</p>
<p style="color:#5c5c5c">If you weren't expecting this, you can ignore this email.</p>
</body></html>
`;
  return { to: input.to, subject: `${input.from} shared a site with you`, text, html };
}
