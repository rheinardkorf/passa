# M5: sharing

| | |
| --- | --- |
| **Status** | Draft |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: viewers other than the owner for the first time, a new tier at the edge, cookies that carry tiers, email to people who aren't publishers, and a mail provider chosen in config |
| **Security-relevant** | Yes: decides who besides the owner can open private pages, sends email on a publisher's behalf, and adds publisher management |

## Summary

Until now, *private* has meant *only the owner*. M5 lets an owner share parts of a site with named people. A path whose rule is `shared` can be opened by the owner and by everyone the site is shared with, after they sign in by magic link with the email it was shared to. Sharing sends them an invite with the site's address. Unsharing, or a share that expires, takes their access away at once.

Two pieces of groundwork come with it, both behind interfaces so another implementation slots in later:

- **The mailer** becomes a provider chosen in config: SES (as now) or SMTP, which works with almost any mail service, in case SES production access never comes, and which the self-hosted target (M6) needs anyway.
- **Publishers** can be added and disabled by admins with `passa admin users`, through the admin function from M4, instead of by editing the database.

Member self-sign-up (anyone joining a site's `members` tier) is out of scope: it needs its own abuse protection.

## Demo

On a private site, `share` its `/plans/` folder with a second address. An invite arrives there with the site's address. Opening it, they sign in by magic link and see `/plans/`, but `/` (still private) sends them to sign in and refuses them. `list_access` shows the share. `unshare`, and their next request is refused. `passa share`, `passa unshare` and `passa access` do the same from a terminal. `passa admin users add` adds a second publisher, who can sign in to MCP; `disable` stops them.

While SES is in sandbox, the second address must be verified in SES; with the SMTP provider, any address works.

## Scope

**In:**

- The `shared` tier, in rules and at the edge.
- `share`, `unshare` and `list_access` tools, and CLI commands.
- Invites, and sign-in by viewers who aren't publishers.
- Shares that expire.
- The mail-provider interface with SES and SMTP providers, chosen in config.
- `passa admin users add | list | disable | enable`.

**Out (later):**

- Member self-sign-up (`members` tier, Join, CAPTCHA): a later milestone.
- Paid tiers (M7) and scheduled access (M8).
- HTTP-API mail providers (Postmark, Resend): another implementation of the same interface, when wanted.
- Different paths for different people: a site has one `shared` tier, and everyone it's shared with sees every `shared` path.

## Requirements

### Sharing

- **R128** `share(site_id, email, path?, expires_at?)` shares a site with an email. It gives the email the site's `shared` tier, and, when `path` (default `/`) is private, makes it `shared` in the site's rules; a path that's already shared or public is left as it is. Sharing never makes anything public, so it never needs `confirm_public`.
- **R129** `share` needs `confirm_share: true`: an agent must read the email back to the person first, since a typo shares private pages with a stranger. Without it, the tool refuses with the email to read back. The CLI asks in the terminal, or takes `--yes`.
- **R130** Sharing sends the email an invite from the deployment's sender: who shared it (the owner's email) and the site's address. It never contains the site's title, a page title or a sign-in token. Sharing again with the same email sends it again, at most once an hour per email and site.
- **R131** `unshare(site_id, email)` removes the share and bumps the site's access version, so every cookie for the site re-checks through `auth.`: viewers still shared with get a new cookie with no email, and the unshared one is refused. Unsharing doesn't change the rules: the paths stay `shared`, for whoever else has the site.
- **R132** `list_access(site_id)` returns the site's rules and its shares: email, when it was shared, when it expires, and whether the invite was sent.
- **R133** A share with `expires_at` stops working then: sign-in and cookie refresh refuse it, and its record is removed (DynamoDB TTL), bumping the access version like an unshare. An expiry is at least an hour ahead and at most a year.
- **R134** A site is shared with at most 100 emails (config `limits.sharesPerSite`). Each publisher sends at most 50 invites a day (config `rateLimits.invitesPerDay`), so Passa can't be used to send email in bulk.

### Viewers

- **R135** Anyone a site is shared with signs in the way the owner does (R15–R18): enter the email, open the magic link, Continue. The sign-in screen still never reveals whether the email has access. A viewer has no publisher account: they're identified only by the verified email of their `auth.` session, and can never publish.
- **R136** A site cookie carries the viewer's tiers on that site: the owner's cookie has every tier, a viewer's has `shared`. The edge serves a path when the cookie's tiers include the path's tier, as well as everything public. The cookie stays host-only, short-lived and signed as now (R11, R18, R19).
- **R137** On a Markdown site, a `shared` page's lists, backlinks, tag pages and feed include only `shared` and public pages (M3 R82), so a viewer never sees a private page's title. `shared` pages get no social cards, since the services that fetch link previews can't sign in.

### Rules

- **R138** `set_access`, `passa access` and the rules file accept the `shared` tier. Changing a path between private and shared needs no `confirm_public`; making it public still does.

### CLI

- **R139** `passa share <site|folder> <email> [--path /plans/] [--expires 2026-12-31] [--yes]`, `passa unshare <site|folder> <email>`, and `passa access <site|folder>` (which now lists shares too).

### Mail providers

- **R140** A mail provider has `send(email)` and `kind`; its bounce and complaint handling, where it has any, records them through the same events, and notifies admins, as SES bounces do today, whichever provider sends. Config `email.provider` chooses `ses` (the default) or `smtp`.
- **R141** The SMTP provider sends over TLS (port 465, or 587 with STARTTLS), with a host, port and user in config and the password in Secrets Manager (on AWS), never in config. It works with any SMTP service. Bounces are left to the service's own suppression, which the docs say.
- **R142** Every email has the same content whichever provider sends it, and none includes a site's title (R12, R15). Tracking stays off.

### Admin users

- **R143** `passa admin users add <email> [--admin] | list | disable <email> | enable <email>` manage publishers through the admin function (M4 R113). Admins in config stay admins; the last active admin can't be disabled. Disabling takes effect on the user's next MCP call (R8) and sign-in, and every change is an event (R31).

### Documentation

- **R144** The docs get a Sharing page (sharing, invites, unsharing, expiry, and what viewers see), mail-provider setup (SES and SMTP, with examples for common services), and admin users.

## Security and quality requirements

- **Sharing private pages is confirmed:** `confirm_share` (R129), read back by the agent, like `confirm_public`.
- **No email enumeration:** sign-in still answers the same whether or not an email has access.
- **No bulk email:** shares per site and invites per day are capped (R134); invites carry no title or token.
- **Revocation is complete:** unshare and expiry bump the access version; site cookies last an hour at most anyway.
- **Viewers never publish:** they have no publisher record, and MCP consent and tool calls still require an active publisher (R8, R24).
- **A share is per site:** one site's `shared` tier says nothing about another's, and a cookie is for one site's host only.
- **Mail credentials** stay out of config: in Secrets Manager on AWS.
- **The last admin can't be locked out** (R143).

## Design

- **Grants:** each share is an item keyed by site and email (`GRANT#<site>`, `EMAIL#<email>`), with its tier, source (`share`), expiry and invite time, plus an index by email for sign-in. A TTL removes it at expiry; the table stream bumps the site's access version, as unshare does directly.
- **Cookies:** `kid.site.v.exp.tiers.sig`, where `tiers` is a short code (`o` for the owner, `s` for shared), covered by the signature. The handoff token carries the tiers too, so the edge sets them without a lookup.
- **Edge:** edge rules gain `s` beside `p` (public) and `x` (private). A path's tier comes from its rule as now; a `shared` path is served when the cookie has `s` or `o`. The function stays within CloudFront's 10 KB limit (checked early).
- **Sign-in:** `auth.` looks up grants by email when there's no publisher record, and sends a link only when the email is the site's owner or has a live share.
- **Mail:** `packages/shared` gets the `MailProvider` interface; `SesMailer` moves behind it; `SmtpMailer` uses Nodemailer (MIT-0, no dependencies). The auth function builds the configured one.
- **Admin users:** new admin-function actions (`users.add`, `users.list`, `users.disable`, `users.enable`) and `passa admin users`.

## Decisions

1. **Sharing only.** Member self-sign-up needs a Join flow and abuse protection (CAPTCHA, WAF), and isn't needed yet.
2. **One `shared` tier per site, not per-person paths.** Simple to reason about and to show in `list_access`; different paths for different people can come later as named tiers.
3. **`share` makes the path shared when it's private,** so "share this with Sam" works in one step, rather than needing a rule change first.
4. **Invites always go,** with no option to skip: the recipient needs the address, and a silent share is easy to forget.
5. **SES and SMTP now, behind an interface.** SMTP covers almost any provider and the self-hosted target; HTTP APIs can be added the same way.
6. **Admin users in M5,** since the admin function exists and adding a second publisher shouldn't mean editing the database.

## To check early

- The edge function's size with tiers in cookies and rules, against CloudFront's 10 KB limit.
- SMTP from Lambda: port 465 or 587 to a real service, Nodemailer's bundle size and cold start, and the password from Secrets Manager.
- A second SES-verified address for the demo while in sandbox.

## Starting values

| Setting | Value |
| --- | --- |
| Shares per site | 100 (`limits.sharesPerSite`) |
| Invites per publisher per day | 50 (`rateLimits.invitesPerDay`) |
| Invite resend | At most hourly per email and site |
| Share expiry | 1 hour to 1 year ahead, optional |
| Mail provider | `ses` (default) or `smtp` |

## Delivery

1. The mail-provider interface, SES behind it, the SMTP provider and its config; tested locally against a test SMTP server, and from a dev Lambda.
2. Grants, `share` / `unshare` / `list_access`, invites, viewer sign-in, tiers in cookies and at the edge, revocation and expiry.
3. The `shared` tier in rules and rendering.
4. `passa share` / `unshare` / `access`, and `passa admin users`.
5. Docs; the demo on dev, then production.

## Done when

- The demo works in production.
- Tested: sharing a private path (made `shared`) and a path already shared; `confirm_share` refused and read back; the invite (no title, no token, resend limit); a viewer's sign-in and what they see (shared paths, not private; lists without private titles; no cards on shared pages); unshare and expiry (refused on the next request, others unaffected); the share and invite limits; a viewer can't publish; SES and SMTP sending, and switching between them in config; `passa admin users` add, disable (MCP refused) and the last-admin guard.
