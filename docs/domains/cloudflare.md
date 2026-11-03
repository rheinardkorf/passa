---
title: Domains in Cloudflare
description: "Custom domains whose DNS is at Cloudflare: the records to add, kept DNS only."
access: public
---

# Domains in Cloudflare

Passa doesn't write Cloudflare records itself yet (that comes with the self-hosted target), so you add two records in the Cloudflare dashboard while the command waits.

> [!warning] Keep both records DNS only
> In Cloudflare, every record has a proxy switch: an orange cloud (**Proxied**) or a grey cloud (**DNS only**). Passa's records must be **DNS only**. Proxied, Cloudflare puts itself in front of CloudFront: the certificate can't be validated, the domain doesn't reach Passa, and Cloudflare would see private pages. If the command finds a proxied record, it says so.

## Add the domain

1. **Start the command**, so it can show you the records:

   ```sh
   passa admin domain add docs.example.com my-docs --new-tenant --stage prod
   ```

   ```
   Adding docs.example.com to my-docs (a tenant of its own).
     Add these records at your DNS host (they can stay):
       CNAME docs.example.com  →  d1abc2def3.cloudfront.net
     Waiting for DNS: 1 record not resolving yet…
     Add these records at your DNS host (they can stay):
       CNAME _3f1c….docs.example.com  →  _9a8b….acm-validations.aws
   ```

   The validation record appears a few seconds after the first one. Leave the command running.

2. **In Cloudflare**, open the domain, then **DNS → Records → Add record**, once for each record the command shows:

   | Field | Pointer record | Validation record |
   | --- | --- | --- |
   | Type | CNAME | CNAME |
   | Name | `docs` (the part before your domain) | `_3f1c….docs` (everything before your domain) |
   | Target | `d1abc2def3.cloudfront.net` | `_9a8b….acm-validations.aws` |
   | Proxy status | **DNS only** (grey cloud) | **DNS only** (grey cloud) |
   | TTL | Auto | Auto |

   Cloudflare adds your domain to the name for you, so enter only the part before it. Copy values from the command exactly, without a trailing dot.

3. **Wait.** Cloudflare's records usually resolve within a minute, and the command carries on by itself: certificate, attaching, deploying, then **Live**.

## An apex domain

For `example.com` itself, the pointer record's **Name** is `@`. Cloudflare allows a CNAME there and *flattens* it, answering with CloudFront's addresses, which works like an alias record. Keep it DNS only.

> [!note]
> Passa's apex support was tested with Route 53 alias records. Cloudflare's flattening should behave the same way, but hasn't been tried with Passa yet. `passa admin domain status` shows whether the records resolve.

## If the domain also has email

Adding these records doesn't affect email: MX, SPF and other records stay as they are. Only change the record for the exact name you're pointing at Passa.

## Remove it

```sh
passa admin domain remove docs.example.com --stage prod
```

Then delete the two records in Cloudflare yourself: Passa only removes records it wrote.
