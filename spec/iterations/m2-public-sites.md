# M2: Public sites and path rules

| | |
| --- | --- |
| **Status** | Approved 2026-10-30 |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Light: extends M1's access check and tools; no new services or data stores |
| **Security-relevant** | Yes: changes who can view sites, and serves content to anyone |

## Summary

A publisher can make a site, or parts of it, public: anyone with the link can open those paths without signing in. Access is set with path rules, where the longest matching prefix decides. Everything not covered by a public rule stays private, as in M1. Optionally, a site can also have a name, so `cv.<siteDomain>` works as well as `<site-id>.<siteDomain>`.

No email is involved, so M2 doesn't depend on SES production access. Sharing with named people comes in M3, which does.

## Demo

Make a site public and open it in a private window without signing in. Make one of its folders private again: that folder asks to sign in, and the rest stays public. Give the site a name and open it at `<name>.<siteDomain>`.

## Scope

**In:**

- Path rules with two tiers: `private` (owner only, as in M1) and `public` (anyone).
- A tool to set a site's rules, and the rules returned by the existing tools.
- Setting access when publishing, so "publish this publicly" is one call.
- The edge serving public paths without a cookie.
- `noindex` on every site by default.
- Named sites (decision 1).

**Out:**

- `shared`, `members` and paid tiers, grants and `list_access` (M3 and later).
- Letting search engines index a site (later; decision 2).
- An admin takedown tool for other publishers' sites (with the admin CLI, M3).
- Custom domains per site (later).

## Requirements

### Rules

- **R32** A site's access is a list of path rules, each a path prefix and a tier. The longest matching prefix decides; a path no rule covers is `private`. A site with no rules is private, as in M1.
- **R33** A rule's path is `/` or a folder ending in `/` (such as `/docs/`), and covers everything under it. Rules are matched against the path the edge serves, after `index.html` is added, so `/docs` and `/docs/` are covered by `/docs/`.
- **R34** `set_access(site_id, rules)` replaces a site's rules. It's refused for paths that aren't valid, for duplicate paths, and for more rules than the limit. The response says exactly which paths are now public, with their URLs.
- **R35** `publish` and `update` take optional `rules`, applied with the new version. Without them, `publish` makes a private site and `update` keeps the current rules.
- **R36** `get_site` and `find_sites` show each site's rules and whether it's private, public or mixed.
- **R37** Making anything public needs the caller to say so explicitly: `set_access` and `publish` refuse rules that add a public path unless `confirm_public` is true. The tool descriptions tell agents to check with the person first, and the tools are marked so clients ask before running them.
- **R38** Rules are only set by the site's owner, and the publisher check of M1 applies (R8).

### Viewing

- **R39** A request for a public path is served without a cookie or sign-in. A request for a private path works exactly as in M1.
- **R40** Changing rules takes effect within seconds, and everywhere within about a minute (KeyValueStore propagation), with no cache invalidation: files stay cached under their version path, and the edge decides access on every request. When a change makes something private, `set_access` says it can stay public for up to a minute.
- **R41** A blocked site (M1's malware finding) serves nothing, whatever its rules.
- **R42** Every site sends `X-Robots-Tag: noindex`, so search engines don't index pages unless that's later turned on for a site.

### Named sites

- **R43** `set_name(site_id, name)` gives a site one name, so it's served at `<name>.<siteDomain>` as well as at its ID. A name is 3–40 lowercase letters, digits and hyphens, can't start or end with a hyphen, can't look like a site ID, and can't be a reserved name (`www`, `mail`, `auth`, `mcp`, `api`, `dev`, `admin`, `status`, and names in config). `set_name(site_id, null)` removes it.
- **R44** Names are unique within a deployment. A name stays taken until its site is purged, so a deleted site's name can't be claimed by someone else during the grace period.
- **R45** A site's returned URL is its name URL when it has one. Both URLs keep working; access is decided the same way on both, and each host gets its own site cookie.

### Events

- **R46** Every change to rules or names is recorded as an event, with the public paths before and after.

## Security and quality requirements

- **Public is opt-in, per path, and explicit** (R37). A mistake in a rule makes too little public, never too much: unmatched paths are private.
- **Same CSP for public pages** as for private ones: no outbound requests, no form posts, CDN allowlist only. Public pages can't collect data.
- **Malware blocking matters more** once pages are public: a blocked site serves nothing (R41), and the alarm already emails the admins.
- **No information about private paths** from public ones: a private path on a public site redirects to sign-in exactly like a private site, and a path that doesn't exist looks the same as a private one.
- **Edge record size:** rules live in the edge record, which KeyValueStore limits to 1 KB, so the number of rules and their length are capped and checked before saving.
- **Names can't be confused with each other or with Passa:** reserved names, no site-ID look-alikes, and lowercase only (hostnames are case-insensitive).

## Design

### The edge record

M1 left `r` empty. M2 fills it with every rule as a `[prefix, tier]` pair, sorted longest first. Private rules are needed too: with `/` public and `/notes/` private, `/notes/` must win.

```
s:<site-id> → { cur: "<version-id>", v: 1, r: [["/notes/", "x"], ["/", "p"]] }   // p: public, x: private
```

The edge resolves the served path (adding `index.html`), takes the first matching prefix, and serves the request without a cookie when its tier is public. Otherwise it runs M1's cookie check.

Names add one record per name, pointing at the site:

```
n:<name> → "<site-id>"
```

The edge reads `n:<label>` when the host's label isn't a site ID, then continues as for that site. The handoff and site cookie use the host the visitor is on, so `auth.` redirects back to the name host when that's where sign-in started.

### Data model

| Entity | PK | SK | GSI1 | Notes |
| --- | --- | --- | --- | --- |
| Site (changed) | `SITE#<id>` | `META` | as M1 | Gains `rules` and `name` |
| Name | `NAME#<name>` | `META` | — | Holds the site ID; created with a condition, so names are unique; removed at purge |

Rules sit on the site item rather than in a separate `RULES` item (as the plan sketched), since they're small and always read with the site.

### Tools

| Tool | Change |
| --- | --- |
| `set_access(site_id, rules, confirm_public?)` | New |
| `set_name(site_id, name)` | New |
| `publish(..., rules?, confirm_public?)` | Optional rules |
| `update(..., rules?, confirm_public?)` | Optional rules |
| `get_site`, `find_sites` | Show rules, access summary and name |

`set_access` and `set_name` carry MCP tool annotations (`destructiveHint`, `openWorldHint`) so clients ask before running them.

## Decisions

1. **Named sites are in M2.** They're what makes public links short (`cv.example.com`), they need no DNS or certificate work (the wildcard covers them), and they're independent of rules, so they can be delivered last or dropped without affecting the rest.
2. **Indexing:** `noindex` everywhere in M2 (R42), with per-site opt-in later. Opting in per site needs a viewer-response function, since the response headers policy is the same for every site.
3. **Confirming public access:** an explicit `confirm_public` argument plus tool annotations (R37). Agents can still pass it without asking, so the tool descriptions say to check with the person first; clients that show tool calls for approval add a second check.

## Starting values

| Setting | Value |
| --- | --- |
| Rules per site | 20 |
| Rule path length | 200 characters |
| Name length | 3–40 characters |
| Reserved names | `www`, `mail`, `auth`, `mcp`, `api`, `dev`, `admin`, `status`, plus config |

## Delivery

1. Rules in the data model and the edge record; the edge serving public paths (local proxy and tests first, then CloudFront's test tool).
2. `set_access`, rules on `publish` and `update`, rules in `get_site` and `find_sites`, and events.
3. `noindex` in the site headers.
4. Named sites: names, the edge lookup, the handoff to name hosts, and `set_name`.
5. Deploy to dev, test, deploy to production.

## Done when

- The demo works in production, from Claude Desktop.
- Tested on dev, including: a private folder inside a public site, a missing path on a public site, rule changes taking effect without invalidation, a blocked site with public rules serving nothing, refused rules, and a name that's reserved, taken or looks like a site ID.
