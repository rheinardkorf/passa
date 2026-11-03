---
title: Custom domains
description: Give a site its own domain, such as docs.example.com, attached with one admin command.
access: public
---

# Custom domains

A site can have its own domain, such as `docs.example.com` or `example.com`. That domain becomes the site's one address: its name and ID addresses redirect there, keeping the path, and its links, feed and social cards use it. Further domains can be aliases, such as `www.example.com`, which redirect to the primary one.

Domains are attached by a deployment's admins, with the deployment's AWS credentials. Passa is self-hosted, so the domains are the owner's own.

## Attach a domain

```sh
passa admin domain add docs.example.com my-docs --new-tenant --stage prod
```

Passa gets a certificate for the domain, adds its DNS records when the domain is in a Route 53 zone the deployment manages (or shows you what to add), attaches it to CloudFront, and switches the site once the domain serves. It reports each step; the whole thing usually takes a few minutes. If you stop it, run the same command again: it carries on where it was.

The first domain a site gets is its primary. Add more as aliases, and use `--primary` to make one the primary instead.

| Command | What it does |
| --- | --- |
| `passa admin domain add <domain> <site> --new-tenant` | Attach a domain with a tenant (and certificate) of its own |
| `passa admin domain add <domain> <site> --fill-tenant` | Attach it to a tenant with room, sharing that tenant's certificate |
| `passa admin domain list` | Every domain, its site, role and tenant |
| `passa admin domain status <domain>` | Its DNS records, and which resolve |
| `passa admin domain remove <domain>` | Detach it; the site moves to its next address first |

Every command takes `--stage` (such as `prod`) and uses your AWS credentials as the AWS CLI does (`AWS_PROFILE`, `aws sso login`). Only people allowed to invoke the deployment's admin function can run them; agents connected to Passa can't.

## Tenants

On AWS, each custom domain is a name on a CloudFront *tenant*, which holds one certificate listing all its names. CloudFront's first 10 tenants are free; after that they cost a small monthly fee. Choosing is up to you each time:

- `--fill-tenant` adds the domain to a tenant with room (up to 10 names, ACM's limit per certificate), so you use as few tenants as possible.
- `--new-tenant` gives the domain its own tenant, so its certificate doesn't list your other domains. Certificates are public anyway, in certificate transparency logs, but a shared one shows which domains belong together.

## DNS records

A domain needs two kinds of record:

- **A pointer** to Passa. For a subdomain (`docs.example.com`) it's a CNAME to the routing endpoint the command shows. An apex (`example.com`) can't have a CNAME, so it needs your DNS host's ALIAS, ANAME or flattened CNAME record instead. Route 53 has alias records; hosts with none of these can't point an apex at Passa, so move the domain's DNS or use `www.`.
- **Certificate validation**, a CNAME that proves to Amazon's certificate authority that you control the domain. Leave it in place: it's checked again when the certificate renews, or when another name joins its tenant.

If the domain's zone is in Route 53 and listed in the deployment's config (`domains.zones`), Passa writes and later removes these records itself. Otherwise the command shows them and waits until they resolve.

> [!warning] Cloudflare
> If the domain's DNS is at Cloudflare, set its records to **DNS only** (grey cloud), not proxied (orange cloud). Proxied, Cloudflare sits in front of CloudFront: the certificate can't validate, and Cloudflare would see private pages. The command says so when it sees a proxied record.

## Private sites and search engines

A private site works at its domain the same way: visitors sign in, and their site cookie is set for that domain. A public site's pages can be indexed at its primary domain, as at a name; aliases and the old addresses only redirect.

## A domain under Passa's own

A site at a subdomain of Passa's own domain (the one `auth.` and `mcp.` are on) is allowed, but the command warns about it: the site is then *same-site* with sign-in. Passa doesn't rely on that boundary, but a separate domain keeps it as an extra layer. See [[Security]].
