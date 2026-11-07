---
title: Sharing
description: "Share parts of a private site with people by email, each seeing only what you shared with them, and take it back at any time."
access: public
---

# Sharing

A private site is yours alone. Sharing lets named people open parts of it too: each person signs in with the email you shared with, and sees what you shared with them, and nothing else that isn't public.

## Sharing a path

Ask your agent to share it, or use the `passa` command:

```sh
passa share my-site acme@example.com --path /proposals/acme/
passa share my-site globex@example.com --path /proposals/globex/
```

Each client now sees their own proposal, and neither can open the other's. Without `--path`, a share is the whole site (`/`).

Sharing does three things:

1. Gives the path a `shared` rule of its own, if it was private. Sharing never makes anything public, and a path that's public already stays public.
2. Lets the email open that path, and any shared folders under it.
3. Emails them an invite: your email address and the link. It never includes the site's title or a sign-in link.

Before anything is shared, the email is read back to you: an agent asks you to check it, and `passa share` asks in the terminal (`--yes` skips the question in scripts). A typo would share private pages with a stranger.

## Folders under folders

A share opens the shared folders at or under its path. So with `/proposals/acme/` and `/proposals/globex/` both shared:

| Shared with | Can open |
| --- | --- |
| `/proposals/acme/` | Acme's proposal |
| `/proposals/globex/` | Globex's proposal |
| `/proposals/` | Both |
| `/` | Everything shared on the site |

When a share opens more than its own folder, Passa says so as you share ("partner@example.com can also open …/proposals/acme/, …/proposals/globex/").

## The shared tier

`shared` is a tier, like `public` and `private`, and it goes in the same rules:

| Tier | Who can open it |
| --- | --- |
| `public` | Anyone with the link, without signing in |
| `shared` | You, and the people it was shared with, after signing in |
| `private` | Only you |

`passa share` sets the rules for you, but you can set them directly too: `passa access my-site --rule /plans/=shared`. Switching between private and shared needs no confirmation; making anything public still does. A site has at most 20 rules, so at most 20 separately shared folders.

## What the people you share with see

They open the link from the invite, enter the email it was sent to, and get a sign-in link by email, as you do. The sign-in page never says whether an email has access, so it can't be used to find out who a site is shared with.

Once signed in, they can open what was shared with them, and anything public. Anything else shows a page saying that email doesn't have access, with a way to sign in with another.

People you share with can view, never publish: Passa keeps a record of their email, with no roles, and its MCP server and the CLI turn them away.

On a Markdown site, a shared page's lists, backlinks and tag pages show only public pages and pages in the same shared folder, so nobody sees the title of a page that isn't theirs. The feed lists public pages only. Shared pages get no social cards, since the services that draw link previews can't sign in.

If a page links to one its readers can't open (such as a shared page's link home to a private page), the link stays, for you, but Passa warns you when you publish: they would only get the no-access page.

## Who has access

```sh
passa access my-site
```

lists the rules, and every share: the email and path, when it was shared, when it expires, and whether the invite went out. A share whose folder was later made private opens nothing, and is marked so. Agents use the `list_access` tool.

## Unsharing

```sh
passa unshare my-site acme@example.com --path /proposals/acme/
passa unshare my-site acme@example.com
```

The first takes away one path; the second, everything shared with that email. Their next request is refused, even with the page already open: every sign-in to the site is checked again, and everyone else carries on without noticing. The rules don't change.

## Shares that end

```sh
passa share my-site acme@example.com --path /proposals/acme/ --expires 2026-12-31
```

ends the share then (a date alone lasts until the end of that day, UTC; agents pass a time with `expires_at`). An expiry is between an hour and a year ahead. When it passes, the share stops working exactly as if you'd unshared it.

## Invites

Sharing the same path with the same email again sends the invite again, at most once an hour. To stop Passa being used to send email in bulk:

- a site can have at most 100 shares (`limits.sharesPerSite`), and
- each publisher can send at most 50 invites a day (`rateLimits.invitesPerDay`).

Both are in the deployment's `config.yml`. Invites come from the deployment's sender; see [[Email]].
