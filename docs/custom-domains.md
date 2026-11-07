---
title: Custom domains
description: "Give a site its own domain, such as docs.example.com, attached with one admin command."
access: public
---

# Custom domains

A site can have its own domain, such as `docs.example.com` or `example.com`. That domain becomes the site's one address: its name and ID addresses redirect there, keeping the path, and its links, feed and social cards use it. More domains can be aliases, such as `www.example.com`, which redirect to the primary one.

Domains are attached by a deployment's admins, with the deployment's AWS credentials. Passa is self-hosted, so the domains are the owner's own.

## Which guide to follow

It depends on where the domain's DNS is hosted, which isn't always where it was bought. To find out, look up its name servers:

```sh
dig +short NS example.com
```

| Name servers look like | Follow |
| --- | --- |
| `ns-123.awsdns-45.com` | [[Domains in Route 53]] |
| `ada.ns.cloudflare.com` | [[Domains in Cloudflare]] |
| Anything else (Rackspace, GoDaddy, Namecheap, your registrar) | [[Domains at other DNS hosts]] |

When something doesn't work, see [[Troubleshooting domains]].

## What happens when you add a domain

```sh
passa admin domain add docs.example.com my-docs --new-tenant
```

1. Passa checks the domain and the site, and claims the domain for the site.
2. It asks Amazon's certificate authority (ACM) for a certificate for the domain.
3. The domain needs two DNS records: a **pointer** to Passa and a **validation** record for the certificate. In a Route 53 zone Passa manages, it writes them; anywhere else, the command shows them for you to add.
4. Once the records resolve, the certificate is issued, usually within a minute or two.
5. Passa attaches the domain and its certificate to CloudFront, which takes another minute or two.
6. The site switches to the domain: its other addresses redirect there, and its Markdown is rendered again with the new address.

The command reports each step and waits. If you stop it, or it times out after 15 minutes, run the same command again: it carries on where it was.

## The two records

| Record | For | Looks like |
| --- | --- | --- |
| **Pointer** | Sends the domain to Passa | `docs.example.com  CNAME  d1abc2def3.cloudfront.net` |
| **Validation** | Proves to ACM that you control the domain | `_3f1c….docs.example.com  CNAME  _9a8b….acm-validations.aws` |

The values are the deployment's own: copy them from the command's output, or from `passa admin domain status <domain>`. Leave the validation record in place for as long as the domain is attached: ACM checks it again when the certificate renews, and whenever another name joins its tenant.

An apex domain (`example.com`, with nothing in front) can't have a CNAME, so its pointer is an **alias** record instead: Route 53's alias, Cloudflare's flattened CNAME, or another host's ALIAS or ANAME. Not every DNS host has one; see [[Domains at other DNS hosts]].

## Commands

| Command | What it does |
| --- | --- |
| `passa admin domain add <domain> <site> --new-tenant` | Attach a domain with a tenant (and certificate) of its own |
| `passa admin domain add <domain> <site> --fill-tenant` | Attach it to a tenant with room, sharing that tenant's certificate |
| `passa admin domain add <domain> <site> … --primary` | Make the domain the site's primary (also to swap an alias in) |
| `passa admin domain list` | Every domain, its site, role and tenant |
| `passa admin domain status <domain>` | Its records, and which of them resolve |
| `passa admin domain remove <domain>` | Detach it; the site moves to its next address first |

Admin commands use your AWS credentials, not your Passa sign-in. The first time, `passa admin` asks which AWS profile reaches the deployment you're signed in to (or takes `--profile`), finds the deployment's admin function in that account, and remembers both. After that, admin commands need nothing extra. When the AWS sign-in has expired, it says how to sign in again with that profile. `--server` picks another deployment, and `--stage` names one directly. Only people allowed to invoke the deployment's admin function can run them; agents connected to Passa can't.

## Tenants

On AWS, each custom domain is a name on a CloudFront *tenant*, which holds one certificate listing all its names. CloudFront's first 10 tenants are free; after that there's a small monthly fee. You choose each time:

- `--fill-tenant` adds the domain to a tenant with room (up to 10 names, ACM's default limit per certificate), so the deployment uses as few tenants as possible.
- `--new-tenant` gives the domain its own tenant, so its certificate doesn't list your other domains. Certificates are public anyway, in certificate transparency logs, but a shared one shows which domains belong together.

## Private sites and search engines

A private site works at its domain the same way: visitors sign in, and their site cookie is set for that domain. A public site's pages can be indexed at its primary domain, as at a name; aliases and the old addresses only redirect.

## A domain under Passa's own

A site at a subdomain of Passa's own domain (the one `auth.` and `mcp.` are on) is allowed, but the command warns about it: the site is then *same-site* with sign-in. Passa doesn't rely on that boundary, but a separate domain keeps it as an extra layer. See [[Security]].
