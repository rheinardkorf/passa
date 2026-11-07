---
title: Membership
description: Open parts of a site to tiers of members, such as gold and silver, add and remove people, and set when their access begins and ends.
access: public
---

# Membership

Tiers let a site have members: groups of people who sign in to open the parts of the site meant for them, such as a course's lessons. A tier is a name, such as `gold` or `silver`. Rules say which tiers open each path (see [[Access]]), and memberships put people in them.

## An example

A course with a free introduction, lessons for paying students, a bonus for the top tier, and drafts only you see:

| Path | Access | Who can open it |
| --- | --- | --- |
| `/` | `[public]` | Anyone |
| `/lessons/` | `[gold, silver]` | Gold and silver members |
| `/lessons/bonus/` | `[gold]` | Gold members |
| `/lessons/draft/` | `private` | Only you |

Tiers are separate: `gold` doesn't include `silver`. A rule lists every tier it opens to, as `/lessons/` does here. You always open everything on your own sites.

## Setting the rules

On a Markdown site, keep them in `_site.yml`, with `tiers` naming the site's tiers:

```yaml
tiers: [gold, silver]
access:
  /: [public]
  /lessons/: [gold, silver]
  /lessons/bonus/: [gold]
  /lessons/draft/: private
```

A page can differ from its folder in its front matter, such as a quiz for silver members only:

```yaml
---
title: The quiz
access: [silver]
---
```

On other sites, set them with `passa access my-site --rule /lessons/=gold,silver --rule /lessons/bonus/=gold`, or ask your agent. Opening a path to tiers needs no confirmation; only making something public does. See [[Access]] for how rules combine.

## Adding and removing members

```sh
passa members add my-course sam@example.com silver
passa members remove my-course sam@example.com --tier silver
passa members remove my-course sam@example.com
passa members list my-course
```

Adding someone emails them an invite: your email address and the site's address, and when their access begins if that's later. It never names the site's title or the tier. The email is read back to you before anyone is added, since a typo would give members' pages to a stranger (`--yes` skips the question in scripts). Adding someone again changes their dates, and sends the invite again at most once an hour.

Removing someone from one tier, or from every tier, takes effect from their next request, even with a page already open; everyone else carries on without noticing.

`passa members list` shows each member's tier, when they were added, their dates, and when they last used it (`never` until they first sign in). `--tier gold` lists one tier. There's no limit on members. Agents use the `add_member`, `remove_member` and `list_members` tools.

## When access begins and ends

```sh
passa members add my-course sam@example.com gold --from 2027-01-01
passa members add my-course sam@example.com gold --for 6m
passa members add my-course sam@example.com gold --expires 2027-06-30
```

`--from` begins a membership on a date, `--expires` ends it on one (at the end of that day, UTC), and `--for` ends it after a time (`30d`, `2w`, `6m`, `1y`), counted from its start. Without an end, a membership lasts until you remove it: a lifetime member, say. Before it begins and after it ends, it opens nothing. An end in the past, or before the start, is refused.

## Members and shares together

A share opens one path to one person, whatever the rule says, so a reviewer can look over the lessons without being a member:

```sh
passa share my-course reviewer@example.com --path /lessons/
```

That opens `/lessons/` and everything under it without a rule of its own, but not `/lessons/bonus/` or `/lessons/draft/`, which have their own rules (Passa says so when you share). Shares always end, 90 days after they begin unless you choose; see [[Sharing]].

To see what one person can open, and why:

```sh
passa access my-course --as sam@example.com
```

```text
sam@example.com on https://my-course.example.com/:
  opens   /  (public)
  opens   /lessons/  (member of silver)
  closed  /lessons/bonus/  (for gold)
  closed  /lessons/draft/  (private)
```

## What members see

Members open the site's link, enter the email they were added with, and get a sign-in link by email; there's no password. They can open what their tiers open, and anything public. Elsewhere, they see a page saying that email doesn't have access, with a way to sign in with another. Members can view, never publish.

On a Markdown site, a page's lists (pages in a folder, tags, backlinks, previous and next) only name pages everyone who can open it can open too: a page for gold and silver members never lists the gold-only bonus. Links to pages some readers can't open stay, and Passa warns you when you publish; each such link carries a `data-passa-rule` attribute, so a theme can style or hide it.
