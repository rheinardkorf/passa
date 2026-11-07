# M4: custom domains

| | |
| --- | --- |
| **Status** | Done 2026-11-03, in production (PR #31; docs #33); approved 2026-11-03 (PR #30) |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: a second CloudFront distribution, certificates and DNS for domains Passa doesn't own, a change to how the edge finds a site, and the first admin commands |
| **Security-relevant** | Yes: decides which hostnames serve which site, issues certificates, writes DNS records, and moves the sign-in handoff to new origins |

## Summary

A site can have its own domain, such as `docs.example.com` or `example.com`, which becomes its one address: its name and ID addresses redirect there, as an ID redirects to a name today. An admin attaches a domain with one command, `passa admin domain add <domain> <site>`; Passa gets a certificate, adds the DNS records when the domain is in a zone it manages (or prints them), and serves the site at the domain once the certificate is in place.

Domains are attached by admins, not publishers. Passa is self-hosted, so the domains are the deployment owner's own; that removes the hard parts of hosting strangers' domains (proving ownership, reclaiming abandoned ones) while keeping the door open to them later.

Two interfaces keep this portable. A **domain provider** attaches a domain and its certificate: on AWS, CloudFront SaaS Manager; self-hosted (M5), Cloudflare. A **DNS provider** writes the records: Route 53 now, Cloudflare in M5, and a manual provider that prints what to add.

## Why the domain needs a step at all

DNS only gets a browser to the right server. Before any request reaches Passa, the browser asks for HTTPS and the server must present a certificate for that exact name, so the edge's code never runs for a name nobody has a certificate for. CloudFront also serves a domain only from the one distribution it's attached to. So before the first visit, something must prove control of the domain, get its certificate and attach it to CloudFront: that's `passa admin domain add`. The last fact, which site the domain is for, can only come from the admin anyway.

## Demo

`passa admin domain add docs.example.com my-docs`: Passa finds `example.com` in Route 53, adds the records, gets the certificate and attaches it, reporting each step. A minute or two later `https://docs.example.com/` serves the site; `my-docs.<siteDomain>/guide/` redirects to `docs.example.com/guide/`; the pages' links, feed and social cards use `docs.example.com`. `passa admin domain list` shows it; `passa admin domain remove docs.example.com` puts the site back on its name.

## Scope

**In:**

- `passa admin domain add | list | status | remove`, over the admin's AWS credentials, never through MCP.
- A site's primary domain, plus aliases that redirect to it (such as `www.example.com` to `example.com`).
- Subdomains and apex domains.
- The domain-provider interface, and its CloudFront SaaS Manager implementation.
- The DNS-provider interface, with Route 53 and manual implementations.
- The edge, sign-in, rendered pages and indexing following the domain.

**Out (later):**

- Cloudflare DNS (M5, with the self-hosted target), and the self-hosted domain provider.
- Publishers attaching their own domains, with DNS ownership proof.
- Wildcard custom domains (`*.example.com` mapping to several sites).
- Moving `*.<siteDomain>` sites onto the multi-tenant distribution.

## Requirements

### Admin commands

- **R113** `passa admin` commands use the admin's AWS credentials (the usual profile or environment) and a stage, and act by invoking the deployment's admin function; being allowed to invoke it is what makes someone an admin. They never go through MCP, and agents connected over MCP can't reach them. Every admin action is recorded as an event (`admin.domain.add`, `admin.domain.remove`). *Amended 2026-11-07:* the stage is optional. The CLI remembers, per server, the AWS profile that reaches its deployment (asked once, or `--profile`) and the admin function, found by matching the function's configured domain to the server's; `--stage` still names the function directly. Expired credentials get a sign-in hint built from the profile's own settings. Admin still runs on AWS credentials, never the Passa sign-in.
- **R114** `passa admin domain add <domain> <site> (--fill-tenant | --new-tenant)` attaches a domain to a site, given by ID or name. The domain must be a valid lowercase hostname, not under the site domain, and not attached to another site. Under Passa's own `domain` it's allowed but warned about: it's then same-site with `auth.` (see Security). The first domain a site gets is its primary; later ones are aliases, and `--primary` makes one primary. One of the two tenant options is required (R119).
- **R115** Attaching runs in order and reports each step: write or print the DNS records, wait until they resolve, get the certificate, attach it, wait until CloudFront serves the domain, then switch the site to it. Nothing redirects to the domain until it serves. Running `add` again resumes an attach that stopped part-way, and a domain that never validates can be removed.
- **R116** `passa admin domain list` shows every domain with its site, role (primary or alias), state and tenant, and how many names each tenant holds. `status <domain>` explains a domain's state: which records are missing or wrong, whether a record is proxied by Cloudflare (it resolves to Cloudflare, not CloudFront: see the docs requirement), and the certificate's state.
- **R117** `passa admin domain remove <domain>` switches the site first (removing its primary moves the site to another of its domains, else its name or ID), so nothing redirects to a domain that's going away, then detaches the domain, and removes the DNS records Passa wrote. Deleting a site detaches its domains with it.

### Providers

- **R118** A domain provider has `records(domain)` (the DNS records the domain needs), `attach(domain, options)`, `status(domain)` and `detach(domain)`. The CloudFront SaaS Manager provider attaches domains as names on distribution tenants of one multi-tenant distribution, each tenant with one ACM certificate validated through DNS that lists all its names, which works for apex domains too.
- **R119** There's no default: the admin chooses. `--fill-tenant` adds the domain to an existing tenant with room for it (or starts one if none has room), so a deployment uses as few tenants as possible, CloudFront's first 10 being free; `--new-tenant` gives the domain a tenant of its own. Adding or removing a name issues a new certificate for that tenant and swaps it in, without interrupting the tenant's other names.
- **R120** A DNS provider has `zoneFor(domain)`, `upsert(records)`, `remove(records)` and `resolves(records)`. Route 53 manages the hosted zones listed in config; for any other domain the manual provider prints the records and the command waits until they resolve. Records Passa writes are only the domain's pointer (a CNAME, or an alias A/AAAA at an apex) and its certificate's validation CNAMEs.

### Serving

- **R121** The sites stack has a multi-tenant distribution beside the current one, with the same edge functions, KeyValueStore, response headers and S3 origin; the bucket allows both distributions.
- **R122** The edge finds a site from a custom domain through the KeyValueStore (`d:<domain>` to a site ID), and a site's edge record carries its primary domain. A site's one address is its primary domain, else its name, else its ID: requests for any other (an alias, the name, the ID) redirect there, keeping the path, as names do now (M2 R45). A domain no site has gets not-found (CloudFront only routes attached domains, so only a slip reaches the edge); a site's ID and name keep R12's rule.
- **R123** Sign-in hands back to the site's current address from the database, its primary domain when it has one, never from the request; the site cookie is set for that host only. Signing in on an old address redirects first, so the cookie lands on the address that serves the site.
- **R124** Absolute URLs in rendered pages (Open Graph, feeds, social cards that show the address) use the site's address. Changing a site's primary domain renders its Markdown again, as changing its name does (M3).
- **R125** A site with a custom domain follows the named-site indexing rule: its public pages can be indexed at the primary domain; redirecting addresses (aliases, the name, the ID) aren't indexed.
- **R126** `get_site`, `find_sites` and `passa site` show a site's domains; `set_name` still works, and a name on a site with a domain redirects to the domain.

### Documentation

- **R127** The docs get a custom domains page: what to add at the DNS host for a subdomain (a CNAME) and an apex (an alias, ANAME or CNAME flattening; hosts without one can't point an apex at Passa), that Cloudflare records must be DNS only (grey cloud), what the domain's certificate validation records are for, and why a domain under Passa's own domain is discouraged.

## Security and quality requirements

- **Only admins attach domains.** Invoking the admin function needs IAM permission that publishers and agents don't have. That's the ownership proof for a self-hosted deployment, so there's no DNS ownership check of the domain itself.
- **A hostname serves only what it's mapped to.** CloudFront routes only attached domains, and the edge still checks the mapping, so a stray DNS record or a detached domain gets not-found, never another site. Mappings are switched before and after attach and detach so a domain never redirects somewhere that doesn't serve.
- **Domains under Passa's own domain** are same-site with `auth.`. Passa doesn't rely on same-site protections (CSRF tokens and `__Host-` cookies), but the command warns and the docs say a separate domain is safer.
- **Least privilege for the admin function:** tenant actions on the one multi-tenant distribution, ACM certificates in us-east-1 tagged for Passa, and Route 53 changes only on the configured zones.
- **Certificate private keys stay in ACM.** Passa never handles them.
- **The edge stays cheap:** one more KeyValueStore read, only for hosts outside the site domain.

## Design

```
passa admin domain add docs.example.com my-site
  └─► invoke passa-<stage>-admin (IAM) ─► DnsProvider: Route 53, or print and wait
                                       ─► DomainProvider: CloudFront tenant + DNS-validated ACM certificate
                                       ─► site record: domains, primary ─► stream ─► KeyValueStore d:docs.example.com, s:<site>.d
                                       ─► re-render (absolute URLs)

browser ─► docs.example.com ─(CNAME or alias)─► connection group endpoint ─► multi-tenant distribution
                                               ─► viewer-request: d:<host> → site ─► same checks, same bucket
```

- **Where the work runs:** in the admin function, a Lambda in the services stack, so the providers run server-side with their own narrow permissions, and the CLI only needs permission to invoke it. Long steps (validation, deployment) are resumable: the function records each domain's state, and the CLI calls it until the domain is live, showing progress.
- **Data:** each domain is an item keyed by the domain (site, role, state, tenant, certificate, records written), written with a condition so a domain can't belong to two sites. The site item lists its domains and its primary. The edge record gains `d`, and `d:<domain>` keys are written by the publisher's `setDomains`, which the admin function calls, as it writes `n:<name>` keys today: new domains before the record that redirects to them, removed ones after.
- **CloudFront:** the multi-tenant distribution has no address of its own; domains point at its connection group's routing endpoint, one address for every domain. Tenants carry the certificate; the distribution carries everything else, defined in CDK. Tenants are created at runtime.
- **Packages:** `packages/shared` gets the provider interfaces and domain records; `packages/infra` the distribution, the admin function and its permissions; `packages/edge` the `d:` lookup; `packages/auth` the domain-aware handoff; `packages/cli` `passa admin domain`.

## Decisions

1. **Attached at runtime by an admin command,** not listed in config and deployed. New domains are a CLI step; the cost is a second, multi-tenant distribution.
2. **CloudFront SaaS Manager beside the current distribution.** It's built for many domains on one configuration, needs no deploy per domain, and its first 10 tenants and their certificates are free. The current `*.<siteDomain>` distribution stays as it is.
3. **DNS-validated ACM certificates for every domain,** rather than CloudFront-managed ones. The early check found managed certificates validate over HTTP, which refuses apex domains pointed by an alias record, and aren't attached to the tenant once issued. One kind of certificate works for every domain and is the ownership proof CloudFront accepts.
4. **The admin chooses `--fill-tenant` or `--new-tenant` every time,** with no default. Filling keeps a deployment within the free tier; a tenant of its own keeps a domain's certificate to itself, since a tenant's certificate lists all its names and so shows which domains share it (certificates are public in transparency logs anyway). Making the choice explicit keeps that trade-off in view.
5. **The admin function does the work,** not the CLI with the admin's own credentials, so permissions stay narrow and the same command can drive a self-hosted deployment in M5.
6. **The DNS-provider interface now, Cloudflare in M5.** Route 53 covers the demo; the manual provider covers any other host.
7. **Aliases redirect to the primary domain,** since `www` and the apex usually both need to work. An alias is one more `d:` key pointing at the site, and with `--fill-tenant` it can share the primary's tenant at no extra cost.

## Early check (done)

A spike in dev, on 2026-11-03, with a throwaway multi-tenant distribution:

- Passa's edge functions and KeyValueStore work on a multi-tenant distribution, and the viewer-request function sees the custom domain as the Host.
- The distribution needs no certificate of its own. A default connection group appears with the first multi-tenant distribution; its routing endpoint is every domain's target.
- A managed certificate was issued in about 30 seconds but not attached; once attached, the domain served within about 2 minutes. Its HTTP validation needs the domain's CNAME in place first, and refuses a domain pointed by an alias record.
- A DNS-validated ACM certificate validated in about 40 seconds; a tenant created with it was active immediately and served an alias-pointed name 13 seconds later.
- Adding a second name to a tenant issued a new certificate in about 20 seconds; the first name served throughout.
- `@aws-sdk/client-cloudfront` (same release as the Lambda client Passa uses) has every tenant, certificate and DNS-check command; `aws-cdk-lib` defines multi-tenant distributions.

## Checked in delivery step 1

- **Names per tenant: 10 by default.** CloudFront allows 100 aliases per tenant, but ACM's default limit is 10 names per certificate (raisable to 100), and a tenant's one certificate lists all its names.
- **Swapping a DNS-validated certificate on a serving tenant doesn't interrupt it.** The CloudFront provider added a name to a tenant serving an alias-pointed name: only the new name's records were needed (the existing name's validation record was reused); the certificate was issued about 80 seconds after the records were added, and the new name served 46 seconds after the update, while the existing name answered every request (every 5 seconds) and the old certificate was deleted.
- **Still to check:** a Cloudflare-flattened apex (DNS only) with a DNS-validated certificate, as an alias was, once a domain is on Cloudflare (M5 brings Cloudflare DNS).

## Starting values

| Setting | Value |
| --- | --- |
| Names per tenant | 10 (ACM's default names per certificate); config `domains.namesPerTenant`, if the ACM limit is raised |
| Route 53 zones Passa may change | config `domains.zones` (none by default) |
| DNS wait before giving up (per command run) | 10 minutes; `add` resumes |
| Edge KeyValueStore key | `d:<domain>` |

## Delivery

1. The provider interfaces and domain records; the Route 53, manual and CloudFront providers, unit tested against fakes; the step-1 checks in dev.
2. The edge `d:` lookup and redirects, the domain-aware handoff and render URLs, tested locally (the local proxy maps a custom Host) and in the integration tests.
3. Infrastructure: the multi-tenant distribution, the admin function and its permissions, the bucket policy; deployed to dev.
4. `passa admin domain add | list | status | remove`; the docs page; the demo on dev with a name in dev's zone.
5. Production: the demo with the Passa docs site on a domain of the deployment's own.

## Done when

- The demo works in production: the Passa docs site serves at its custom domain, and its name and ID redirect there.
- Tested: subdomain and apex (alias-record) domains; `--fill-tenant` adding a second domain to a tenant without interrupting the first; `--new-tenant`; `add` without either (refused); an alias redirecting to the primary, and `--primary` switching them; a domain whose records aren't there yet (waits, then resumes); a Cloudflare-proxied record (reported); a domain already attached elsewhere (refused); a domain under the site domain (refused); sign-in on a private site at its domain; remove (the site goes back to its name, records removed); deleting a site with a domain.
