# M3: Self-hosted target

| | |
| --- | --- |
| **Status** | Approved 2026-10-31 |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: a second deployment target, with new stores, packaging and a new way in from the internet |
| **Security-relevant** | Yes: new data stores, new entry points, secrets on disk, email through SMTP, and a third party (Cloudflare) in front of everything |

## Summary

Passa runs on a single Linux container (a Proxmox LXC, say) as well as on AWS. One Node process serves `auth.`, `mcp.` and the sites, keeps its data in SQLite and on the filesystem, and sends email through SMTP. Cloudflare Tunnel connects it to the internet, so the container opens no ports. Installing and updating is one script, with no Docker.

AWS stays the main target and works as it does now. Both targets share the same application code, and every test that covers storage runs against both.

The SMTP mailer is built here, because this is where it can be tested for real. AWS keeps sending through SES; switching an AWS deployment to SMTP later is a config change.

## Demo

On a fresh Debian LXC, run the install script and the Cloudflare Tunnel guide. Connect Claude Code to `mcp.<domain>`, signing in by email. Publish a private site and open it after signing in; make it public and open it in a private window; give it a name.

## Scope

**In:**

- A storage layer with DynamoDB and SQLite backends, so the data logic is written once.
- Site files on the filesystem, with signed upload and download URLs served by `mcp.`.
- An SMTP mailer beside the SES one.
- Signing keys and secrets in files, beside KMS and Secrets Manager.
- Malware scanning with ClamAV, optional.
- One server process that runs the edge, `auth.`, `mcp.` and the timer that replaces TTL and stream processing.
- An install and update script that installs from a release, and systemd hardening.
- Releases: tagged, with built bundles and checksums.
- A Cloudflare Tunnel guide.

**Out:**

- Docker, and other packaging (later, if needed).
- More than one machine: no shared database, no high availability.
- Moving a deployment between AWS and self-hosted.
- SMTP bounce handling beyond the provider's own suppression list.
- Switching the AWS deployments to SMTP (possible after this, by config).
- A dev stage on the same machine: a self-hosted dev setup is a separate deployment with its own domains.

## Requirements

### Running

- **R49** A self-hosted deployment runs as one service on one Linux machine with Node.js 24.15 or later, and needs no AWS account and no Docker.
- **R50** Every tool and every page behaves the same on both targets, apart from the differences listed in this spec. The integration tests for storage, publishing, sign-in and the edge run against both.
- **R51** The server listens only on loopback. Cloudflare Tunnel, on the same machine, is its only way in.
- **R52** Changes take effect immediately: the edge reads the same database the tools write, so there's no propagation delay (M2's R40 minute doesn't apply).

### Storage

- **R53** Data lives in one SQLite database in WAL mode, and site files in a data folder: `sites/<site-id>/<version-id>/<path>` and `uploads/<upload-id>/<path>`. Paths are checked before they reach the filesystem, as they are before S3 today, and resolved paths must stay inside the data folder.
- **R54** Uniqueness and concurrency hold as on AWS: every conditional write and transaction (unique names, `base_version`, rule writes on `updatedAt`) is a SQLite transaction with the same conditions.
- **R55** Events stay append-only: the events table refuses updates and deletes at the database level.
- **R56** Upload and download URLs are signed by the server. Each covers one file and an expiry; an upload URL also covers the exact size, and the server refuses a body of any other size.
- **R57** Expired items are removed by the timer, which also does what DynamoDB streams do on AWS: purges sites at the end of the grace period, and removes expired names from the edge. Reads check expiry themselves, as they do on AWS, so a late timer never makes anything valid longer.

### Email

- **R58** Email goes through SES or SMTP, set in config, on either target. SMTP requires TLS (implicit or STARTTLS) and authenticates; the password is a secret, never in config.
- **R59** With SMTP, an address that bounces isn't disabled automatically; the provider's suppression list stops the mail. Everything else about sign-in email is unchanged.

### Keys and secrets

- **R60** The access-token signing key (ES256) and the auth secrets (cookie keys, site keys) are generated on install and kept in files readable only by the service.
- **R61** Rotating keys works as on AWS: a new key is added in front, and old keys are dropped once nothing signed with them is valid.

### Malware

- **R62** With ClamAV installed, every file is scanned before it's written to the sites folder, and a finding refuses the publish. There's no "scanned after writing" case, so no site is ever blocked by a late finding.
- **R63** Without ClamAV, scanning is off: the install script says so, and the server logs a warning on every start.

### Install and update

- **R64** One script installs Passa: Node.js from the official release with its checksum checked, a `passa` system user, the code in `/opt/passa`, config and secrets in `/etc/passa`, data in `/var/lib/passa`, and a hardened systemd unit. Running it again updates to a newer release and keeps config, secrets and data.
- **R65** Releases are built in CI from a tag, with checksums and a build attestation. The script checks the checksum before unpacking.
- **R66** `passa backup` writes a consistent copy of the database and the data folder, safe while the service runs.

## Security and quality requirements

- **Same protections as on AWS:** the same CSP, `noindex` and site cookies. A separate sites domain is optional on both targets (decision 6).
- **Cloudflare must never cache site responses.** On AWS, the edge checks access before CloudFront's cache; with Cloudflare in front, a cached private file could be served to anyone. Self-hosted site responses send `Cache-Control: private, no-store`, and the guide adds a cache rule that bypasses the cache for the sites domain, so either alone is enough.
- **Cloudflare must not change pages:** the guide turns off Rocket Loader, email obfuscation, automatic HTTPS rewrites and Web Analytics injection for the sites domain. Changed pages would break the CSP, and serve something other than what the agent published.
- **Trusting forwarded headers:** the viewer's IP comes from `CF-Connecting-IP` and the scheme is always HTTPS, trusted only because the server listens on loopback (R51).
- **TLS ends at Cloudflare.** Cloudflare can read private sites in transit. The README and the guide say so plainly.
- **Rate limits without WAF or API Gateway:** the server applies WAF's per-IP limits to `auth.` itself, with the existing request counters, and API Gateway's overall throttle to `mcp.`. The guide adds a Cloudflare rate-limiting rule in front where the plan allows it.
- **Least privilege on the machine:** the unit runs as `passa`, with a read-only system, write access only to `/var/lib/passa`, no new privileges and a private `/tmp`. Secrets are mode 0600.
- **Supply chain:** releases are checksummed and attested; Node.js is checked against its published checksums; the install script is in the repo and short enough to read.

## Design

### Components

| Component | AWS | Self-hosted |
| --- | --- | --- |
| Edge | CloudFront Function + KeyValueStore | The same `handler.js` in the server, reading edge records from SQLite |
| Auth service | CloudFront + WAF → Lambda | The same Express app in the server |
| MCP server | API Gateway → Lambda | The same Express app in the server |
| Data | DynamoDB | SQLite |
| Files | S3 | The data folder |
| Background work | DynamoDB streams, EventBridge → Lambda | The timer, in the server |
| Email | SES | SES or SMTP |
| Keys and secrets | KMS, Secrets Manager | Files in `/etc/passa` |
| Malware | GuardDuty | ClamAV, optional |
| In front | CloudFront, WAF | Cloudflare Tunnel |

### The storage layer

`Store`, `OidcStore`, `TableEdgeStore` and `Events` talk to DynamoDB directly today, with about 30 kinds of condition and update expressions. Rather than write each of them twice, they move onto a small table interface, and only that interface has two backends:

```ts
interface Table {
  get(key): Promise<Item | undefined>;
  put(item, condition?): Promise<void>;
  update(key, changes: { set?, remove?, add? }, condition?): Promise<void>;
  delete(key, condition?): Promise<void>;
  query(index: 'main' | 'gsi1', pk, sk?: { equals } | { beginsWith }, page?): Promise<{ items; next? }>;
  transact(writes): Promise<void>; // all or nothing; reports which condition failed
}
```

Conditions are a small typed tree (`exists`, `notExists`, `equals`, `lessThan`, `in`, `and`, `or`) rather than strings. The DynamoDB backend turns them into the same expressions as today; the SQLite backend checks them inside a transaction.

Each target uses one backend: AWS always runs on DynamoDB, and SQLite is only ever used self-hosted. Item shapes and keys don't change, so nothing on AWS migrates. In SQLite, items are rows of `(pk, sk, gsi1pk, gsi1sk, ttl, item JSON)`, with indexes on the key pairs and `ttl`. The events table is its own SQLite table, with triggers that refuse updates and deletes.

### Files

`SiteFiles` becomes an interface with S3 and filesystem implementations. Content types are in the version's file list already, so the filesystem needs no metadata of its own. Signed URLs point at `mcp.<domain>/files/...`, signed with an HMAC key from the secrets file; uploads are written to a temporary file and renamed once the size matches. The timer deletes uploads older than their lifetime, as the uploads bucket's expiry does on AWS.

### The server

`passa serve` routes by host, as the local proxy does now: `auth.<domain>` and `mcp.<domain>` go to their apps, and `*.<siteDomain>` goes through the edge handler and then the sites folder, with the same headers CloudFront adds. The local proxy becomes this server with local settings, so local development and self-hosting run the same code.

The timer runs every minute in the same process: it removes expired items, and passes expired `PURGE#` and `NAME#` items to the same handlers the stream function calls.

### The machine

```
/opt/passa/<version>/      the release; /opt/passa/current points at the running one
/etc/passa/config.yml      config (no secrets)
/etc/passa/secrets.json    auth secrets, the HMAC key, the SMTP password (0600)
/etc/passa/token-key.pem   the ES256 signing key (0600)
/var/lib/passa/passa.db    the database
/var/lib/passa/sites/      site files
/var/lib/passa/uploads/    uploads waiting to be published
```

Updating unpacks the new release beside the old one, switches the link and restarts the service; rolling back is switching it back. Database changes between releases are forward-only and run on start, after an automatic backup.

### Cloudflare Tunnel

`cloudflared` runs as its own systemd unit on the same machine. Its ingress sends `auth.<domain>`, `mcp.<domain>` and `*.<siteDomain>` to the server on loopback, and refuses everything else. With one domain, a single wildcard covers all three. The guide covers: the domain or domains on Cloudflare, a proxied wildcard record for the sites (the free certificate covers one level, which is all one deployment needs), the cache rule, the page features to turn off, and turning off bot challenges for `auth.` and `mcp.`, since MCP clients and OAuth callbacks can't solve them. Cloudflare's 100 MB request limit on the free plan is above Passa's 25 MB file limit.

### Config

A `selfHosted` section holds what only applies there (port, data folder, ClamAV socket); `accounts` is only needed for AWS. `email` gains an optional `smtp` block (host, port, user), with the password in the secrets file on self-hosted or in Secrets Manager on AWS.

## Technology choices

| Choice | Why |
| --- | --- |
| **`node:sqlite`** | Built into Node, so no native module to compile on the machine. A release candidate since Node 24.15, with transactions, prepared statements and online backup. If it changes before it's stable, only the SQLite backend is affected |
| **SQLite** over Postgres | One file, nothing else to run or patch, backed up with the container. One machine is the scope |
| **Nodemailer** for SMTP | Mature, MIT, no dependencies |
| **ClamAV** (`clamd`) | The standard open-source scanner, from Debian's packages. Its signatures need about 1 GB of memory, so it's optional |
| **Cloudflare Tunnel** | No open ports, no certificates to manage on the machine, and wildcard hostnames on the free plan |
| **systemd**, no Docker | Proxmox LXCs run systemd already, and Docker inside an LXC needs nesting and extra privileges |

## Decisions

1. **A shared table layer, not two stores.** Writing `Store` twice would double every later feature's data code. The table layer keeps the data logic and item shapes in one place, and the DynamoDB side produces the same requests as now. The cost is refactoring working AWS code; the existing tests, run against Moto, guard it.
2. **One process.** The edge, `auth.`, `mcp.` and the timer share one Node process and one database connection, so there's one unit to run and SQLite has a single writer. Separate processes would need SQLite's locking across processes for no gain on one machine.
3. **`cloudflared` on the same machine.** It keeps the server on loopback (R51), which is what makes `CF-Connecting-IP` trustworthy. Running it elsewhere would need the server on the network and a shared secret header, so it's left out.
4. **Scan before writing.** ClamAV scans in-process before a file is stored, which is simpler and stricter than GuardDuty's scan-after-write, so self-hosted needs no blocking path.
5. **Install from releases, not from source.** The machine needs only Node, not pnpm and a build, and what runs is exactly what CI built.
6. **One domain is fine self-hosted.** `siteDomain` already defaults to `domain`, so `auth.`, `mcp.` and the sites can share one domain and one wildcard. Passa stays safe either way: `auth.` uses `__Host-` cookies and CSRF tokens, and never relies on same-site rules. A second domain limits the blast radius instead: a page flagged as phishing can get the whole domain flagged, `auth.` and sign-in email included, and site scripts could read cookies set for the whole domain by anything else on it. For a personal deployment, one domain is a reasonable trade, so the self-hosted guide documents it and the domain must host nothing else (`www`, `blog` and other labels you want go in `reservedNames`). The AWS guidance keeps recommending two.

## Data

- **Personal data:** as on AWS (emails and IPs), stored on the machine.
- **Third parties:** Cloudflare (all traffic, including private sites, passes through it unencrypted at its edge), and the SMTP provider (email addresses and sign-in links).

## To check early

1. **`node:sqlite` under load:** concurrent requests on one connection, WAL, online backup while writing, and the conditions of R54 under parallel writes.
2. **Signed uploads through Cloudflare:** a 25 MB upload through the tunnel, with the exact-size check.
3. **Cloudflare caching and page changes:** with the cache rule and settings in the guide, confirm a private file is never served from cache and pages arrive byte for byte.
4. **MCP and OAuth through Cloudflare:** Claude Code and claude.ai connect, with no bot challenge in the way.

## Starting values

| Setting | Value |
| --- | --- |
| Node.js | 24.15 or later |
| Port | 8080, loopback only |
| Timer | every 60 seconds |
| Signed URL lifetime | `lifetimes.uploadUrl`, as on AWS |
| `mcp.` throttle | 20 requests per second in all, bursts of 40 (as API Gateway) |
| `auth.` limits | as WAF: 600 requests per IP per 5 minutes, 30 to forms |

## Delivery

1. The early checks.
2. The table layer, with the DynamoDB backend; `Store`, `OidcStore`, `TableEdgeStore` and `Events` moved onto it. AWS unchanged, all tests passing on Moto, deployed to dev.
3. The SQLite backend; the storage tests run against both.
4. Files, keys and secrets, and the mailer behind their interfaces, with the filesystem, key-file and SMTP implementations.
5. `passa serve`: the edge, the apps, signed URLs, rate limits and the timer; the end-to-end tests run against it. The local proxy moves onto it.
6. ClamAV.
7. Releases, the install script, systemd hardening and `passa backup`.
8. The Cloudflare guide; install on the LXC and run the demo.

## Done when

- The demo works on the LXC, from Claude Code and claude.ai.
- Every storage, publishing, sign-in and edge test passes on both backends.
- AWS dev and production run the refactored code with no change in behaviour.
- Tested on the LXC, including: a private file never served from Cloudflare's cache, a public site made private taking effect at once, an upload of the wrong size refused, a site purged and a name expired by the timer, an update and a rollback of the release, and a restore from `passa backup`.
