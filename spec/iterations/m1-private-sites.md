# M1: Private sites over OAuth

| | |
| --- | --- |
| **Status** | Approved 2026-10-28 |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: new architecture, new auth model, new data stores |
| **Security-relevant** | Yes: new entry points, data stores, secrets, logging and authentication |

## Summary

An agent connected to Passa over OAuth can publish a folder of files as a private site on its own subdomain, update it without changing the link, and roll it back. Only the site's owner can open it, after signing in with a magic link. Everything runs in one AWS deployment created with CDK.

## Demo

Publish a page from claude.ai, open the returned link, sign in with a magic link and see the page. Sign in with a different email and get refused.

## Scope

**In:**

- OAuth 2.1 authorization server on `auth.<domain>`, following the MCP authorization spec.
- Publishing MCP server on `mcp.<domain>` with the M1 tools below.
- Sites served from `<site-id>.<domain>` through CloudFront, with access checked at the edge.
- Magic-link sign-in by email, site cookies, sign-out and a connected-apps page.
- Users bootstrapped from config: one or more admins, each also a publisher.
- An append-only events table, including security events.
- Publish-time checks and a strict content security policy on every site.
- Local development against Moto (a local AWS emulator) and a local edge proxy.
- CDK stacks for a dev account and a production account.

**Out (later milestones):**

- Any tier other than `private`: path rules and public paths (M2); sharing and members (M3).
- Payments (M4) and scheduled access (M5).
- Adding or disabling publishers after deployment (an admin CLI, M3).
- Site APIs under `/_passa/api/`. M1 only reserves the path.
- A CloudFormation template and Launch Stack button.

## Requirements

### Publishing

- **R1** `publish(files | upload_id, title, data_source?, data_as_of?)` creates a private site with a random ID and returns its URL.
- **R2** Small sites are sent inline in the tool call. Larger sites use `begin_upload(file_list)`, which returns presigned S3 upload URLs, then `finish_upload(upload_id)`.
- **R3** `update(site_id, files | upload_id, remove?, edits?, base_version?, replace_all?)` creates a new version from the current one: the files sent are added or replaced, `edits` replace text that appears exactly once in a text file, the paths in `remove` are removed, and everything else is carried over. With `replace_all`, the files sent become the whole site. The URL doesn't change. An update built on a version that is no longer current is refused, so concurrent updates can't undo each other; with `base_version`, so is one from an agent that read an older version.
- **R4** `get_site(site_id)` returns the site's metadata, its versions newest first a page at a time, and every file's size, type and SHA-256 hash, and `get_files(site_id, paths)` returns the contents of the files asked for (text inline up to the inline limit, binary files and text past the limit as short-lived download links), so any agent can continue another agent's site.
- **R5** `find_sites(query)` lists the caller's own sites newest first, a page at a time, matching on title.
- **R6** `rollback(site_id, version_id)` makes an earlier version current again, instantly.
- **R7** `delete(site_id, now)` removes a site after a grace period, or immediately when `now` is true. Hard delete removes it from S3, DynamoDB and the edge record.
- **R8** Every tool acts only on the caller's own sites, and checks on every call that the caller is still an active publisher.
- **R9** Every tool input is validated against a strict schema and rejected if it doesn't match.

### Viewing

- **R10** A request to a site without a valid cookie redirects to `auth.<domain>` to sign in.
- **R11** After sign-in, the site's owner gets a short-lived cookie for that site's subdomain only, and sees the current version.
- **R12** Anyone else is refused, with a page that doesn't reveal the site's title or whether the email has access.
- **R13** Version files are served from immutable paths and cached indefinitely. Publishing or rolling back moves the current version without a cache invalidation.
- **R14** The path `/_passa/` is reserved: publishing refuses files under it, and the edge never serves it from storage.

### Sign-in

- **R15** A visitor enters their email and always sees the same response ("if you have access, check your email"). An email is only sent when the address has access.
- **R16** The magic link is single-use, expires after 15 minutes, carries its token in the URL fragment, and is only stored as a hash.
- **R17** The link opens a page with a Continue button. The token is only used when Continue is pressed, so email scanners that open links don't use it up.
- **R18** Sign-in creates a new `auth.` session (with a newly generated ID), with an idle timeout and a maximum lifetime. Opening other sites refreshes their cookies through `auth.` without another email.
- **R19** Sign out ends the `auth.` session. Site cookies then lapse within their short lifetime.
- **R20** Every form on `auth.` carries a CSRF token. Sign-in requests are rate-limited by email and IP.

### Publishing access (OAuth)

- **R21** The MCP server answers unauthenticated requests with `401` and a pointer to its protected resource metadata. `auth.` publishes authorization server metadata.
- **R22** Clients can register with a client ID metadata document or with dynamic client registration.
- **R23** The authorization code flow requires PKCE with `S256` and a `resource` parameter naming the MCP server.
- **R24** Sign-in is the magic link. The consent screen shows the client's name, its client ID and, prominently, the host it redirects to. Only active publishers can approve; anyone else is refused before consent.
- **R25** Redirect URIs match exactly, except loopback redirects (`http://localhost`, `http://127.0.0.1`), which match on any port.
- **R26** Access tokens are signed JWTs, valid for about an hour, bound to the MCP server as their audience, and checked for signature, issuer, audience, expiry and scope on every call. Each carries its grant ID, and the MCP server checks the grant still exists, so revoking a client or a refresh-token chain takes effect immediately rather than when the token expires.
- **R27** Refresh tokens are stored as hashes and replaced on every use. Reusing an old one is rejected and revokes the whole grant.
- **R28** Fetching a client ID metadata document follows SSRF rules: HTTPS only, no private or internal addresses, no redirects, and size and time limits. Other URLs in client metadata are never fetched.
- **R29** A connected-apps page on `auth.` lists the publisher's authorized clients and revokes any of them.

### Users and events

- **R30** Admin emails come from config and are written as user records on deploy. Sites are owned by a stable user ID, never by email.
- **R31** Every publish, update, rollback and delete is recorded as an event, and so are security events: sign-in successes and failures, refused authorizations, rejected inputs and token failures. Each event has a timestamp, user ID or email, action, IP and result.

## Security and quality requirements

- **Content security policy** on every site: inline scripts allowed, outbound requests and form posts blocked (`connect-src 'none'`, `form-action 'none'`), and scripts, styles and fonts only from a short CDN allowlist.
- **Publish-time checks:** total and per-file size limits, dotfiles skipped, file types checked by content, credential and secret scanning, and malware scanning with GuardDuty Malware Protection for S3. A failed check refuses the publish. Inline publishes are the exception for malware: they're scanned after they're written, and a finding blocks the site (see step 7).
- **Cookies** are host-only, `HttpOnly`, `Secure` and `SameSite=Lax`.
- **Errors** are generic: no stack traces, and nothing that reveals whether an email or site exists.
- **Logs** never contain tokens. Emails in application logs are masked. The edge never logs personal data.
- **Rate limits:** AWS WAF on `auth.` (sign-in and OAuth endpoints), and API Gateway throttling on `mcp.`.
- **No hardcoded secrets or environment branching.** Lifetimes, limits and flags are config values.
- **Data access** goes through one module using key-condition queries only. Scans are only for standalone maintenance jobs.

## Design

What this iteration introduces:

### Components

| Component | Runs on | Purpose |
| --- | --- | --- |
| Edge | CloudFront Function + KeyValueStore | Maps hostnames to sites, checks cookies, rewrites to the current version |
| Auth service | CloudFront + WAF → Lambda function URL (`auth.`) | Authorization server, magic links, sessions, site cookies, connected apps |
| MCP server | API Gateway HTTP API → Lambda (`mcp.`) | Publishing tools, token checks |
| Storage | S3, DynamoDB | Immutable site versions, metadata, users, OAuth records, events |
| Email | SES | Magic links only, in M1 |

### The edge record

The CloudFront Function can't call DynamoDB, so each site has one compact KeyValueStore record, rewritten whenever the site changes:

```
s:<site-id> → { cur: "<version-id>", v: <access version>, r: [] }
```

`r` (path rules) stays empty in M1, which means private. The Function reads the record, checks the site cookie (signature, site, expiry, access version), and rewrites the request to `/<site-id>/<version-id>/<path>`. DynamoDB is the source of truth; a standalone `reconcile` job rebuilds every edge record from it.

Details settled in step 4:

- **Sign-in handoff.** `auth.` can't set a cookie for a site's host, so after sign-in it redirects to `https://<site-id>.<siteDomain>/_passa/session` with a token signed with the cookie key. The token is valid for 60 seconds, bound to the site, its access version, the return path and the cookie lifetime. The Function checks it and sets the site cookie (`__Host-passa`, so host-only by construction). The Function can't record that a token was used, so a token copied within its 60 seconds works again. It only ever grants the same access to the same site.
- **Missing sites look private.** A site with no edge record (never existed, or being deleted) gets the same sign-in redirect as a private one, so the redirect can't be used to test whether a site exists. Deleting a site removes its record at once; the grace period only allows undoing.
- **Paths.** Only paths made of publishable characters reach storage; anything else is a 404. A path ending in `/`, or with no extension in its last part, serves that folder's `index.html`.
- **Caching.** CloudFront caches each version's files indefinitely under their version path. Viewers get `Cache-Control: private, no-cache`, so browsers revalidate and see an update or rollback straight away.
- **Site domain.** Sites are served from `<site-id>.<siteDomain>`, which defaults to `domain`. Deployments can choose a separate domain so that published pages, which run any script, aren't same-site with `auth.`: on one domain, `SameSite` cookies give `auth.` no protection from them, so `auth.` must rely on CSRF tokens (R20) and `__Host-` cookies. The edge only answers on the site domain, and its sign-in redirect goes to `https://auth.<domain>`, both fixed when the Function is built.
- **Locally,** the proxy runs the same handler file, and a DynamoDB table in Moto stands in for KeyValueStore.

Details settled in step 5:

- **The `auth.` app** is Express. Step 6 mounts `oidc-provider` in the same app, and its login step uses the session below rather than a second one.
- **Sessions** are random 256-bit IDs in a `__Host-passa-session` cookie, stored only as a hash. Idle expiry counts from the last request (recorded at most every five minutes); the maximum lifetime counts from sign-in. Signing in ends any session the browser already had. A disabled user's session stops working at once.
- **Site access in M1** is the owner of an active site. With a valid session, `/site/signin` redirects straight to the handoff, so other sites and expired site cookies need no email. Without access, the refused page is the same whether the site exists or not.
- **Who gets an email:** an active user who can view the requested site, or any active user when no site is named. Everyone sees the same page. The response can take longer when an email is sent; rate limits and WAF bound what that reveals.
- **CSRF:** every form carries the value of a `__Host-passa-csrf` cookie (double submit), and every post must come from the `auth.` origin. The `__Host-` prefix stops sites, even on the same domain, from setting either cookie.
- **Rate limits** are fixed windows counted in DynamoDB, per email and per IP (both hashed). Requests over the limit get the usual page and no email.
- **Magic links aren't bound to the browser that asked**, so a link requested on a laptop can be opened on a phone. The token is single-use, short-lived and only in the fragment.
- **Pages** load one stylesheet and one script from `auth.` itself (CSP `default-src 'none'`). The script moves the token from the fragment into the Continue form and removes it from the address bar.
- **Locally,** the proxy serves sign-in at `localhost:8080` too (plain `localhost`, since OAuth clients only allow HTTP for that exact name). Emails go through Moto's SES, which delivers nothing, so the proxy also prints them.

Details settled in step 6:

- **One session.** `oidc-provider` runs in the `auth.` app. A login-policy check asks for a Passa sign-in unless there's a valid `auth.` session for the account `oidc-provider` remembers, so signing out of Passa also stops apps being authorized silently, and a cookie set by a site can't sign anyone in.
- **Consent** shows the app's name and client ID, and most prominently the host it sends you back to. Non-publishers get no email for an app sign-in, and anyone signed in without publisher access is refused before consent. A grant lasts the refresh-token lifetime (30 days) from consent; after that the app has to be allowed again.
- **After a form post, pages that lead elsewhere move on by themselves** (a meta refresh) instead of redirecting, because browsers check every redirect after a post against `form-action`, and the last one goes to the app. The CSP stays `form-action 'self'`.
- **Access tokens** are ES256 JWTs signed in KMS, with the KMS key ID as `kid`. The MCP server verifies them with the key's public half from KMS, so it never calls `auth.`, and checks the grant on every call.
- **Clients** are public or use a client secret; `private_key_jwt` is off, so no client `jwks_uri` is ever fetched. Client ID metadata documents are fetched under `oidc-provider`'s SSRF protection (special-use addresses refused after connecting, no redirects, 2.5 s, 5 KB), and names that only make sense on a private network are refused first. Dynamic registration is open, as MCP clients expect; WAF rate-limits it in step 7.
- **The MCP endpoint** is stateless: `POST /mcp` only, plain JSON responses, one server per request. Tokens that fail are recorded as events; a client's first request, which has none, isn't.
- **Secrets:** `oidc-provider`'s cookie keys are in Secrets Manager (`{ "cookieKeys": [...] }`; the first signs, all verify).
- **Locally,** sign-in and the token endpoint are on plain `http://localhost:8080`, because MCP clients only allow plain HTTP for that exact name; MCP is on `mcp.localhost:8080`. `setup` creates the token key in Moto's KMS and the cookie keys in its Secrets Manager. Claude Code connects to the local MCP server for real.
- **Browser tests** drive the installed Chrome through site sign-in and app consent (`playwright-core`, no browser download), since Origin headers, referrer policy, CSP and `__Host-` cookies only behave for real in a browser.

Details settled in step 7:

- **Stacks,** per stage and named `passa-<stage>-<part>`, so a deployment can share its AWS accounts with other projects: `foundation` (hosted zones and the SES identity, deployed first because DNS and SES production access take time), `data` (tables, buckets, the token key, the auth secret and KeyValueStore), `global` in us-east-1 (certificates and WAF, which CloudFront only takes from there), `services` (`auth.`, `mcp.` and the background functions) and `sites` (the edge distribution). Production keeps its data if a stack is deleted, and its stacks have termination protection. A stage can override `domain`, `siteDomain` and `email` in config; dev usually runs on subdomains delegated from production's zones.
- **`auth.`** is CloudFront with WAF in front of a function URL. CloudFront adds a secret origin header, and the function answers nothing without it. A viewer-request function copies the viewer's host into `x-passa-host`, overwriting anything sent; the IP comes from `CloudFront-Viewer-Address`. WAF blocks known bad IPs and inputs, and rate-limits each IP, with a lower limit on sign-in and client registration.
- **`mcp.`** is an API Gateway HTTP API with throttling, on its custom domain only (the `execute-api` address is off). The IP comes from API Gateway's request context.
- **Keys:** one Secrets Manager secret holds `oidc-provider`'s cookie keys, the site keys (`[{ kid, secret }]`, the first signs) and the origin header's value. On deploy, a custom resource completes the secret, generating only what's missing so existing keys survive, and copies the site keys to KeyValueStore for the edge. CloudFront Functions can't read any secrets store, so the site keys are the one secret held there; only that custom resource can put keys.
- **The edge on CloudFront** runs the same `handler.js`, built with the KeyValueStore's ID. CloudFront's runtime rejects some syntax Node accepts (such as `await` inside call arguments), so lint bans it and each deploy is checked with CloudFront's test tool. A site's record reaches edge locations a few seconds after a publish, so a valid handoff for a site with no record yet shows a page that reloads every two seconds instead of failing; an invalid one is still a 404. Storage misses get the edge's plain 404, not S3's error XML.
- **Purge:** the table stream, filtered to TTL removals of `PURGE` items, triggers the hard delete. A site that's no longer being deleted is left alone.
- **Malware:** GuardDuty Malware Protection scans every new object in both buckets and tags it with the result. Publishing from an upload checks each file's tag before the upload is claimed: a threat or an unscannable file refuses the publish, and a file still being scanned asks the agent to retry. Inline publishes are written straight to the sites bucket, so a finding there sets the site to `blocked`: it's taken off the edge, can't be updated or rolled back, and can only be deleted. Every finding is recorded and alarmed.
- **Email** goes through an SES configuration set that reports bounces and complaints. A permanent bounce or a complaint disables the user, except admins, so one complaint can't lock a deployment's owners out; SES's suppression list stops the mail either way. `auth.` may send through any identity, since SES's sandbox checks the recipient's too, but only from the configured sender.
- **Alarms** on SES's bounce and complaint rates, malware findings and function errors are emailed to the admins.
- **Admins** from config get their user records when `auth.` starts (R30).
- **Also:** the authorization server allows the code flow only, and refused form posts and consents are recorded with their reason, never a token (R31).
- **On Lambda,** the Express-to-Lambda adapter hands over request bodies already read, so the MCP endpoint parses those itself, under the same size limit.

### Data model (M1 entities)

Table `passa-<stage>`, single-table design, on-demand billing, point-in-time recovery, TTL on `ttl`, and a stream of removed items for purges.

| Entity | PK | SK | GSI1 (PK / SK) |
| --- | --- | --- | --- |
| User | `USER#<userId>` | `PROFILE` | `EMAIL#<email>` / `USER` |
| Site | `SITE#<id>` | `META` | `OWNER#<ownerId>` / `SITE#<createdAt>` |
| Version | `SITE#<id>` | `VER#<versionId>` | — |
| Sign-in token | `TOKEN#<hash>` | `META` | — (expires by TTL) |
| Session | `SESSION#<hash>` | `META` | — (expires by TTL, at the earlier of idle and maximum expiry) |
| Rate counter | `RATE#<name>` | `W#<window start>` | — (expires by TTL) |
| Upload | `UPLOAD#<uploadId>` | `META` | — (expires by TTL) |
| Pending purge | `PURGE#<siteId>` | `META` | — (its TTL, at the end of the grace period, triggers the hard delete) |
| OAuth records | `OIDC#<model>#<id>` | `META` | Tokens and codes: `OIDCGRANT#<grantId>` / `OIDC#<model>#<id>` (revoking a grant finds all its tokens). Sessions: `OIDCUID#<uid>` / `Session`. Grants: `OIDCACCOUNT#<userId>` / `OIDC#Grant#<id>` (the connected-apps page) |

Site IDs are fully random. Version IDs are ULIDs, only ever shown to the owner. A site's status is `active`, `deleting` or `blocked`. Events go to a separate append-only `passa-<stage>-events` table, keyed by day (`DAY#<date>`) and timestamp.

Site files live in a sites bucket under `<site-id>/<version-id>/<path>`. Uploads are staged in a separate uploads bucket that expires objects on its own; `finish_upload` checks every declared file arrived at its declared size, and the files are checked again and copied into the sites bucket when `publish` or `update` uses the upload. Every version is a complete folder: an update copies unchanged files from the current version within S3, so agents only send what changed, and rollback stays a pointer change.

## Technology choices

| Choice | Why |
| --- | --- |
| **AWS CDK (TypeScript)** for infrastructure | First-class constructs for CloudFront Functions, KeyValueStore and Origin Access Control, and the same language as the application |
| **`oidc-provider`** for the authorization server | A certified OAuth/OpenID library. A local test confirmed client ID metadata documents, resource indicators, JWT access tokens, PKCE and refresh-token rotation, all through configuration |
| **CloudFront Functions + KeyValueStore** for access checks | Runs on every request at low cost and latency, with no origin call for the check |
| **API Gateway HTTP API** for `mcp.` | Returns `WWW-Authenticate` intact, which MCP clients use to find the auth server (Lambda function URLs rename it). Built-in throttling. Tokens are checked in the function rather than by a gateway authorizer, because the `401` must carry MCP's `resource_metadata` and every call checks the grant |
| **CloudFront + WAF → Lambda function URL** for `auth.` | WAF provides rate limits and CAPTCHA, and can't attach to an HTTP API. CloudFront adds a secret origin header that the function checks, since Origin Access Control requires signed request bodies, which browsers and OAuth clients don't send |
| **Node.js LTS** on Lambda | `oidc-provider` supports LTS releases only. Bundles keep class names (esbuild `keepNames`), because `oidc-provider` names its stored records after its classes |
| **Moto** for local AWS | Open source (Apache-2.0), one container, no account. LocalStack now requires an account and auth token, and its free plan is non-commercial only, which doesn't suit an open-source project's contributors. Moto doesn't verify presigned URL signatures, so upload limits enforced by S3 are tested on the dev account |
| **pnpm** with exact versions and supply-chain settings | Reproducible installs and protection against freshly published malicious packages |

## Data

- **Personal data:** email addresses (users, sign-in tokens, events) and IP addresses (events).
- **Region:** every service that stores or processes data runs in the deployment's main region, set in config. Only edge infrastructure that stores no data is global.
- **Third parties:** none in M1 beyond AWS. MCP clients such as claude.ai connect from their providers' servers; the data they send is the site content the publisher chose to publish.

## To check early

These could change the design, so they come first in implementation:

1. **Function URLs or API Gateway.** Decided: API Gateway HTTP API for `mcp.`. Stateless MCP with plain JSON responses needs no streaming, so both work. But function URLs rename `WWW-Authenticate` to `x-amzn-Remapped-www-authenticate`, and a CloudFront function can't rename it back. Claude Code falls back to the well-known metadata URL; other clients may not. Origin Access Control rejects MCP's unsigned POST bodies.
2. **KMS signing.** Confirmed: `oidc-provider`'s experimental external signing key signs tokens in KMS (`ECC_NIST_P256`; KMS returns DER signatures, converted to the JOSE format). About 50 ms per signature, measured from outside AWS. Because the feature is experimental, the library version is pinned and a test covers signing.
3. **Lambda fit.** Confirmed: `oidc-provider` with a DynamoDB adapter (indexes on grant ID, interaction UID and user code) ran the full flow on AWS, from Claude Code too. Cold starts were 0.4–0.56 s of initialization, then 20–70 ms per request, at about 120 MB of memory. Minifying without `keepNames` breaks it.
4. **Refresh-token reuse.** Confirmed: reusing a refresh token revokes the whole grant, including the newest refresh token. Access tokens already issued stay valid until they expire, which R26 closes with a grant check on every call.

## Starting values

All config, so they can change without code changes:

| Setting | Proposed |
| --- | --- |
| Access token | 1 hour |
| Refresh token | 30 days, rotated on use |
| Site cookie | 1 hour |
| `auth.` session | 7 days idle, 30 days maximum |
| Magic link | 15 minutes |
| Sign-in requests | 5 per email and 30 per IP, per hour |
| WAF on `auth.` | 600 requests per IP per 5 minutes; 30 to sign-in and client registration |
| `mcp.` throttling | 20 requests per second, bursts of 40 |
| Inline publish size | 1 MB total |
| Site size | 100 MB total, 25 MB per file |
| Delete grace period | 7 days |
| CDN allowlist | `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `unpkg.com`, `fonts.googleapis.com`, `fonts.gstatic.com` |

## Delivery

1. Repo setup: pnpm workspace (`auth`, `mcp`, `edge`, `infra`, `shared`), CI, PR template, `SECURITY.md`, `config.example.yml`.
2. The early checks above.
3. Storage and publishing tools against Moto.
4. The edge handler, local proxy, version routing and CSP.
5. Magic links, sessions and site cookies, with SES in Moto.
6. The authorization server, MCP auth and the connected-apps page.
7. CDK stacks; deploy to dev, test, deploy to production, smoke test. Connect claude.ai and Mobile.

## Done when

- The demo works against production.
- Tested on dev, including refused sign-ins, refused consent, invalid tokens, rejected inputs and blocked outbound requests from a published page.
