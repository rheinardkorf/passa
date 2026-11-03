---
title: Domains at other DNS hosts
description: "Custom domains whose DNS is anywhere else: the two records to add, and the traps that differ by host."
access: public
---

# Domains at other DNS hosts

For a domain whose DNS is anywhere other than a Route 53 zone Passa manages (Rackspace, GoDaddy, Namecheap, your registrar, or Route 53 in another AWS account), you add two records at the DNS host while the command waits.

## Add the domain

1. **Start the command**, so it can show you the records:

   ```sh
   passa admin domain add docs.example.com my-docs --new-tenant --stage prod
   ```

   It shows the pointer record first, then the validation record a few seconds later. Leave it running.

2. **Add both records at your DNS host**, as CNAME records, exactly as shown. Then wait: the command carries on by itself once they resolve.

That's all, unless one of the traps below applies.

## Trap 1: the name field

DNS hosts disagree about what goes in the name (or "host") field:

- **Most hosts want only the part before your domain.** For `docs.example.com`, enter `docs`; for the validation record `_3f1c….docs.example.com`, enter `_3f1c….docs`. GoDaddy, Namecheap and Rackspace work this way.
- **Some want the full name**, and some accept either.

If you enter the full name where a host expects the short one, it quietly creates `docs.example.com.example.com`, and the command waits forever. `passa admin domain status` shows which records don't resolve. To see what a name actually returns:

```sh
dig +short CNAME docs.example.com
```

## Trap 2: trailing dots

The command shows names and values without the final dot. Some hosts add one, some want one, and a few treat a value without it as relative to your domain (turning `d1abc2def3.cloudfront.net` into `d1abc2def3.cloudfront.net.example.com`). If a record doesn't resolve, try the value with a trailing dot.

## Trap 3: apex domains

An apex (`example.com`, with nothing in front) can't have a CNAME. Its pointer needs one of these, depending on the host:

| What the host calls it | Examples (check your host's current docs) |
| --- | --- |
| Alias record | Route 53 |
| ALIAS record | DNSimple |
| ANAME record | DNS Made Easy, some others |
| CNAME flattening | Cloudflare |

Many hosts have none of these, including GoDaddy and, as far as we know, Rackspace Cloud DNS. For an apex domain at one of those, you can:

- **Move the domain's DNS** to a host that has one, such as Cloudflare (free) or Route 53. You keep the domain where it's registered; only its name servers change. Copy every existing record across first, especially MX records for email.
- **Use `www`** as the site's domain (a plain CNAME works there), and have your registrar forward the apex to `www`, if it offers forwarding.

## Trap 4: CAA records

A CAA record lists which certificate authorities may issue certificates for a domain. Most domains have none, and then any authority may. But if the domain, or a parent of it, has CAA records, they must include Amazon's, or the certificate is never issued:

```sh
dig +short CAA example.com
```

If that prints anything, add a CAA record allowing `amazon.com`:

```
example.com.  CAA  0 issue "amazon.com"
```

## Trap 5: an old record in the way

If the name already has a record (say `www` points at an old host), most hosts won't let you add a CNAME beside it. Change the existing record to the new value, or delete it first. A CNAME can't share its name with any other record.

## Remove it

```sh
passa admin domain remove docs.example.com --stage prod
```

Then delete the two records at your DNS host yourself: Passa only removes records it wrote.
