---
title: Sharing
description: "Share parts of a private site with people by email: they sign in to see them, and lose access the moment you unshare."
access: public
---

# Sharing

A private site is yours alone. Sharing lets named people open parts of it too: they sign in with the email you shared with, and see the site's shared paths, never its private ones.

## Sharing a site

Ask your agent to share it, or use the `passa` command:

```sh
passa share my-site sam@example.com --path /plans/
```

That does three things:

1. Gives `sam@example.com` access to the site's **shared** paths.
2. Makes `/plans/` shared, if it was private. Without `--path`, that's the whole site (`/`). Paths that are already shared or public stay as they are, so sharing never makes anything public.
3. Emails Sam an invite: your email address and the site's link. It never includes the site's title or a sign-in link.

Before anything is shared, the email is read back to you: an agent asks you to check it, and `passa share` asks in the terminal (`--yes` skips the question in scripts). A typo would share private pages with a stranger.

## The shared tier

`shared` is a tier, like `public` and `private`, and it goes in the same rules:

| Tier | Who can open it |
| --- | --- |
| `public` | Anyone with the link, without signing in |
| `shared` | You, and everyone the site is shared with, after signing in |
| `private` | Only you |

A site has one shared tier, so everyone you share it with sees every shared path, not only the one you named. Sharing `/reports/` with Kim on a site whose `/plans/` is shared with Sam lets each of them open both. When that's the case, Passa says so as you share ("kim@example.com can also open …/plans/"). To share different things with different people, use different sites.

You can set it directly, too: `passa access my-site --rule /plans/=shared`, or `--shared` for the whole site. Switching between private and shared needs no confirmation; making anything public still does.

## What the people you share with see

Sam opens the link from the invite, enters the email it was sent to, and gets a sign-in link by email, as you do. The sign-in page never says whether an email has access, so it can't be used to find out who a site is shared with.

Once signed in, Sam can open the shared paths, and anything public. A private path shows a page saying that email doesn't have access, with a way to sign in with another.

People you share with can view, never publish: Passa keeps a record of their email, with no roles, and its MCP server and the CLI turn them away.

On a Markdown site, a shared page's lists, backlinks, tag pages and feed show only shared and public pages, so Sam never sees a private page's title. Shared pages get no social cards, since the services that draw link previews can't sign in.

If a shared page links to a private one (such as a link home), the link stays, for you, but Passa warns you when you publish: Sam would only get the no-access page.

## Who has access

```sh
passa access my-site
```

lists the rules, and everyone the site is shared with: when it was shared, when it expires, and whether the invite went out. Agents use the `list_access` tool.

## Unsharing

```sh
passa unshare my-site sam@example.com
```

Sam's next request is refused, even with the page already open: every sign-in to the site is checked again, and everyone else it's shared with carries on without noticing. The rules don't change, so the paths stay shared for them.

## Shares that end

```sh
passa share my-site sam@example.com --expires 2026-12-31
```

ends the share then (a date alone lasts until the end of that day, UTC; agents pass a time with `expires_at`). An expiry is between an hour and a year ahead. When it passes, Sam is refused exactly as if you'd unshared.

## Invites

Sharing again with the same email sends the invite again, at most once an hour per site and email. To stop Passa being used to send email in bulk:

- a site can be shared with at most 100 emails (`limits.sharesPerSite`), and
- each publisher can send at most 50 invites a day (`rateLimits.invitesPerDay`).

Both are in the deployment's `config.yml`. Invites come from the deployment's sender; see [[Email]].
