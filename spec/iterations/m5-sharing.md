# M5: sharing

| | |
| --- | --- |
| **Status** | Approved 2026-11-05 (PR #44) |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: viewers other than the owner for the first time, a new tier at the edge, cookies that carry tiers, email to people who aren't publishers, and a mail provider chosen in config |
| **Security-relevant** | Yes: decides who besides the owner can open private pages, sends email on a publisher's behalf, and adds publisher management |

## Summary

Until now, *private* has meant *only the owner*. M5 lets an owner share parts of a site with named people. Each share names a path, such as one client's proposal folder, and the person it's shared with can open it, after they sign in by magic link with the email it was shared to, and nothing else that isn't public. Sharing sends them an invite with the site's address. Unsharing, or a share that expires, takes their access away at once.

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
- Membership tiers, where everyone in a tier sees the same paths: a later milestone (see decision 2).

## Requirements

### Sharing

- **R128** `share(site_id, email, path?, expires_at?)` shares one path of a site (default `/`, the whole site) with an email. The email may then open the site's `shared` rules at or under that path, and nothing else that isn't public: sharing `/proposals/acme/` with one client and `/proposals/globex/` with another keeps each from the other. Unless the path is public, it gets a `shared` rule of its own, made or kept, so each shared path is its own audience. Sharing never makes anything public, so it never needs `confirm_public`. The result lists shared folders under the path that open with it (`also_opens`), so the person isn't surprised.
- **R129** `share` needs `confirm_share: true`: an agent must read the email back to the person first, since a typo shares private pages with a stranger. Without it, the tool refuses with the email to read back. The CLI asks in the terminal, or takes `--yes`.
- **R130** Sharing sends the email an invite from the deployment's sender: who shared it (the owner's email) and the site's address. It never contains the site's title, a page title or a sign-in token. Sharing again with the same email sends it again, at most once an hour per email and site.
- **R131** `unshare(site_id, email, path?)` removes one shared path, or with no path every path shared with the email, and bumps the site's access version, so every cookie for the site re-checks through `auth.`: everyone else gets a new cookie without noticing, and the unshared path is refused. Unsharing doesn't change the rules.
- **R132** `list_access(site_id)` returns the site's rules and its shares: each email and path, when it was shared, when it expires, whether the invite was sent, and whether it opens nothing (its path no longer has a shared rule at or under it).
- **R133** A share with `expires_at` stops working then: sign-in and cookie refresh refuse it, and its record is removed (DynamoDB TTL), bumping the access version like an unshare. An expiry is at least an hour ahead and at most a year.
- **R134** A site has at most 100 shares, each an email and a path (config `limits.sharesPerSite`). Each publisher sends at most 50 invites a day (config `rateLimits.invitesPerDay`), so Passa can't be used to send email in bulk. A site still has at most 20 rules, so at most 20 separately shared paths.

### Viewers

- **R135** Anyone a site is shared with signs in the way the owner does (R15–R18): enter the email, open the magic link, Continue. The sign-in screen still never reveals whether the email has access. A viewer's first sign-in gives them a user record with no roles, so they can sign in to view but never publish; what they can open comes from the shares for their verified email.
- **R136** A site cookie carries what the viewer may open on that site: the owner's cookie opens everything; a viewer's lists the shared rules their shares open, by ID. The edge serves a path when its rule is public, or when the cookie lists its rule. A viewer who opens anything else is refused at `auth.`, which shows who they're signed in as and offers another email. The cookie stays host-only, short-lived and signed as now (R11, R18, R19).
- **R137** On a Markdown site, a `shared` page's lists, backlinks and tag pages include only public pages and pages under the same shared rule (M3 R82), which anyone who can open the page can open; so a viewer never sees the title of a page that isn't theirs. The feed lists public pages only. `shared` pages get no social cards, since the services that fetch link previews can't sign in. A link on a page to one its readers can't open (a shared page's link home to a private page) stays, for those who can follow it, and is reported once for the site; so is a page whose front matter says `access: private` that the rules make shared.

### Rules

- **R138** `set_access`, `passa access` and the rules file accept the `shared` tier. Changing a path between private and shared needs no `confirm_public`; making it public still does.

### CLI

- **R139** The CLI does everything the MCP tools do (cli.md): `passa share <site|folder> <email> [--path /plans/] [--expires 2026-12-31] [--yes]` (asking in the terminal to confirm the email, as R129), `passa unshare <site|folder> <email>`, and `passa access <site|folder>`, which now lists shares too (`list_access`), takes `--shared` beside `--public` and `--private`, and says what a change made shared.

### Mail providers

- **R140** A mail provider has `send(email)` and `kind`; its bounce and complaint handling, where it has any, records them through the same events, and notifies admins, as SES bounces do today, whichever provider sends. Config `email.provider` chooses `ses` (the default) or `smtp`.
- **R141** The SMTP provider sends over TLS (port 465, or 587 with STARTTLS), with a host, port and user in config and the password in a Parameter Store `SecureString` (on AWS), never in config. It works with any SMTP service. Bounces are left to the service's own suppression, which the docs say. Some services only send from the account's own address or verified aliases (Gmail rewrites any other `From`), which the docs say too.
- **R142** Every email has the same content whichever provider sends it, and none includes a site's title (R12, R15). Tracking stays off.
- **R145** Mail is sent in the background, handed off without waiting, so sign-in and `share` answer in the same time whichever provider sends and whether or not an email was sent (R15). An SMTP send takes 2–3 seconds (early check), which would otherwise slow sign-in and show whether an email has access.

### Admin users

- **R143** `passa admin users add <email> [--admin] | list | disable <email> | enable <email>` manage publishers through the admin function (M4 R113). Admins in config stay admins; the last active admin can't be disabled. Disabling takes effect on the user's next MCP call (R8) and sign-in, and every change is an event (R31).

### Documentation

- **R144** The docs get a Sharing page (sharing, invites, unsharing, expiry, and what viewers see), mail-provider setup (SES and SMTP, with examples for common services), and admin users.

## Security and quality requirements

- **Sharing private pages is confirmed:** `confirm_share` (R129), read back by the agent, like `confirm_public`.
- **No email enumeration:** sign-in still answers the same whether or not an email has access.
- **No bulk email:** shares per site and invites per day are capped (R134); invites carry no title or token.
- **Revocation is complete:** unshare and expiry bump the access version; site cookies last an hour at most anyway.
- **Viewers never publish:** their user record has no roles, and MCP consent and tool calls still require an active publisher (R8, R24).
- **A share is per path and per site:** a share opens only the shared rules at or under its path, one site's shares say nothing about another's, and a cookie is for one site's host only.
- **Lists never leak across shares:** a shared page lists only pages under its own rule (R137).
- **Mail credentials** stay out of config: in a Parameter Store `SecureString` on AWS, encrypted with KMS.
- **The last admin can't be locked out** (R143).

## Design

- **Grants:** each share is an item in the site's partition (`SITE#<site>`, `GRANT#<email>#<path>`), with its tier, source (`share`), expiry and invite time; one email's shares are a prefix query, and the site's all of them. Emails with `#` are refused. A TTL removes a share at expiry; the table stream bumps the site's access version, as unshare does directly. Until DynamoDB removes it, sign-in and cookie refresh treat it as gone.
- **Cookies:** `kid.site.v.exp.tiers.sig`, where `tiers` is `o` for the owner, or `s-<id>-<id>…` for a viewer: the IDs of the shared rules they may open (at most 20), covered by the signature. A rule's ID is the first 8 hex digits of its path's SHA-256. The handoff token carries the tiers too, so the edge sets them without a lookup. A rule shared after a viewer's cookie was issued opens at their next visit through `auth.`.
- **Edge:** edge rules gain `s` beside `p` (public) and `x` (private), with the rule's ID: `[path, "s", id]`. The longest matching rule decides as now; a shared rule is served when the cookie is the owner's or lists its ID. A shared rule without an ID is treated as private. The function is at 7.7 of CloudFront's 10 KB.
- **Sign-in:** `auth.` reads the site's grant for the email, and sends a link only when the email is the site's owner or has a live share. Someone with a share and no user record gets one with no roles.
- **Mail:** `packages/shared` gets the `MailProvider` interface; `SesMailer` moves behind it; `SmtpMailer` uses Nodemailer (MIT-0, no dependencies). A small mail function sends; `auth.` and the MCP server hand it the message asynchronously (R145), as they hand cards to the cards function.
- **Admin users:** new admin-function actions (`users.add`, `users.list`, `users.disable`, `users.enable`) and `passa admin users`. Users are listed through a second index, `gsi2`, overloaded and sparse: only items that set `gsi2pk` are in it, and every user record sets `USERS`, sorted by email. Passa never scans the table to list things. Users written before the index were added by a one-off `passa admin users reindex` (a scan), run on every deployment and then removed (2026-11-07); admins in config are rewritten whenever `auth.` starts.

## Decisions

1. **Sharing only.** Member self-sign-up needs a Join flow and abuse protection (CAPTCHA, WAF), and isn't needed yet.
2. **Shares by path, each shared path its own audience.** Decided after the dev demo (2026-11-06): one shared tier per site exposed every shared path to everyone a site was shared with, which doesn't fit sharing a proposal with one client. A share now names a path and opens the shared rules at or under it. Membership tiers (later) are the other model, where everyone in a tier sees the same paths; they'll sit beside shares.
3. **`share` gives the path a shared rule of its own,** so "share this with Sam" works in one step, rather than needing a rule change first, and the rule lines up with the share.
4. **Invites always go,** with no option to skip: the recipient needs the address, and a silent share is easy to forget.
5. **SES and SMTP now, behind an interface.** SMTP covers almost any provider and the self-hosted target; HTTP APIs can be added the same way.
6. **Admin users in M5,** since the admin function exists and adding a second publisher shouldn't mean editing the database.

## Early checks

- **Edge size: passes.** The viewer-request function is at 7,335 of 10,240 bytes today; tiers in cookies and rules, prototyped, add 292 bytes (74%). Whitespace minification would free another 1.2 KB if a later milestone needs it.
- **SMTP from Lambda: passes,** through Gmail on ports 465 and 587, with the password from a Parameter Store `SecureString` (`ssm:GetParameter` was enough). Nodemailer adds 239 KB and the cold start was 320 ms, but **a send takes 2–3 seconds**, hence R145. Gmail sends only as the account's own address or its verified aliases.
- **A second address for the demo: done.** A second email is verified in dev's SES, so the demo's sharing invite and sign-in reach it while SES is in sandbox. Passa treats it as a different person from the owner, even where both addresses reach the same inbox.

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
- Every MCP tool, old and new, has a CLI command (R139).
- Tested: sharing a private path (made `shared`) and a path already shared; two people shared different paths of one site, each refused the other's; `confirm_share` refused and read back; the invite (no title, no token, resend limit); a viewer's sign-in and what they see (shared paths, not private; lists without private titles; no cards on shared pages); unshare and expiry (refused on the next request, others unaffected); the share and invite limits; a viewer can't publish; SES and SMTP sending, and switching between them in config; `passa admin users` add, disable (MCP refused) and the last-admin guard.
