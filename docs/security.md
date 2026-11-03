---
title: Security
description: How Passa keeps private sites private, and how to report a problem.
access: public
---

# Security

Passa's job is keeping private things private, so most of its design is about that.

## How sites are protected

- **Checked at the edge.** Every request to a site is checked by a CloudFront Function before anything is served. Private pages need a valid sign-in for that site; there's no way to reach the files around it.
- **Private by default.** A new site is private, anything no rule covers is private, and nothing becomes public without an explicit confirmation.
- **One origin per site.** Each site has its own subdomain, so one site's scripts can't read another's pages or cookies.
- **A strict Content Security Policy.** Pages can load scripts and styles only from the site and a few public CDNs, and can't make network requests or post forms anywhere. A page can't send what it shows to someone else.
- **Nothing leaks through lists.** On Markdown sites, lists, tag pages, feeds and social cards only ever include pages the visitor can see.

## How sign-in works

- **Magic links,** sent by email: no passwords to steal or reuse.
- **OAuth 2.1 for agents and the CLI,** with PKCE, tokens that are short-lived and bound to the MCP server, and refresh tokens that change each time they're used. Every connected app can be revoked.
- **Publishers only.** Only people a deployment's admins have added can publish.

## What the server checks

Agents can be wrong, or misled by what they read, so the server never trusts them: it checks every input, refuses to make anything public without confirmation, scans uploads for malware, and records every change.

## Choosing a site domain

Serve sites from a registrable domain of their own, separate from Passa's `auth.` and `mcp.`. Passa doesn't depend on it, but it adds a layer: browsers then treat sites and sign-in as different sites entirely.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's [private vulnerability reporting](https://github.com/rheinardkorf/passa/security/advisories/new) for the repository, not in a public issue. Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week.

Each deployment runs in its owner's AWS account. Problems in a particular deployment's configuration should go to its owner.
