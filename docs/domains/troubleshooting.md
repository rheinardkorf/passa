---
title: Troubleshooting domains
description: "When a custom domain won't go live, or doesn't behave: what the symptom means and what to do."
access: public
---

# Troubleshooting domains

Start with `passa admin domain status <domain>`. It shows the domain's state and each record, with ✓ for records that resolve and ✗ for those that don't, and says why when it can tell.

## It's stuck at "Waiting for DNS"

The records don't resolve as Passa expects yet.

- **Just added?** Give it a few minutes. Some hosts take longer, and an old record's TTL can delay a change by that many seconds.
- **Check what the name returns:** `dig +short CNAME docs.example.com`. Nothing means the record isn't there under that name (see [the name field](/domains/other-dns-hosts/)); a different value means another record is in the way.
- **"resolves to Cloudflare"** means the record is proxied: set it to **DNS only** (grey cloud). See [[Domains in Cloudflare]].
- **"points at …, not …"** means the record exists with the wrong value: copy the value from the command again.

## It's stuck at "Waiting for the certificate"

The records resolve, but ACM hasn't issued the certificate.

- It's normally under two minutes once the validation record resolves. Wait a little longer.
- **A CAA record** that doesn't allow Amazon stops it entirely: see [CAA records](/domains/other-dns-hosts/).
- If the command reports that the certificate **failed** or **timed out**, remove the domain and add it again once the records are right.

## It stopped with "Run the same command again"

The command gave up waiting after 15 minutes, but nothing was lost. Fix whatever `status` shows, then run the same `add` command: it carries on from where it was.

## The domain shows a certificate error in the browser

- **Right after it went live:** CloudFront may take a minute more to serve the certificate everywhere.
- **An apex at a host with no alias record**, pointed with an A record to an address you looked up: CloudFront's addresses change, so this breaks. Use an alias or move the DNS (see [apex domains](/domains/other-dns-hosts/)).

## The domain says "Not found"

The domain reaches Passa, but no site serves it. That happens briefly while a domain is being removed, or if its records still exist after it was removed. Check `passa admin domain list`, and delete leftover records at your DNS host.

## The old address doesn't redirect, or a page shows the old address

- Redirects start once the domain is live. Right after, the edge can take up to a minute to see the change everywhere.
- Links and social cards come from the site's rendered pages, which Passa renders again when the domain goes live. If you sync the site's folder, draw its cards for the new address: `passa render --site-url https://docs.example.com/`, or let `passa sync` do it.

## "already attached to a site"

A domain belongs to one site at a time. Remove it from the other site first (`passa admin domain remove`), then add it to this one.

## "Your AWS credentials can't invoke …" or "Couldn't use your AWS credentials"

`passa admin` uses AWS credentials, not a Passa sign-in: run `aws sso login` (or set `AWS_PROFILE`) for the deployment's account, and set `AWS_REGION` to the region Passa is deployed in. Only admins can invoke the admin function.
