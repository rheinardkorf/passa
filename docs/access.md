---
title: Access
description: Private by default; rules make folders or whole sites public, or share them with people you name.
access: public
---

# Access

Every site starts private: only the person who published it can open it, after signing in. Rules change that.

## Rules

A site's access is a list of rules. Each rule is a path — `/` for the whole site, or a folder ending in `/` — and a tier:

| Tier | Who can open it |
| --- | --- |
| `public` | Anyone with the link, without signing in |
| `shared` | You, and the people the site is shared with, after signing in (see [[Sharing]]) |
| `private` | Only you |

The longest matching rule decides, and anything no rule covers is private. So:

```yaml
- { path: /, tier: public }
- { path: /drafts/, tier: private }
```

makes the whole site public except `/drafts/`. An empty list makes the whole site private again.

Changes take effect within seconds, and everywhere within about a minute.

## Making things public needs a yes

Passa refuses any change that would make something public unless the request says the person agreed (`confirm_public`). An agent has to check with you first; the `passa` command asks you in the terminal, or takes `--confirm-public` in scripts. Changes between private and shared need no confirmation, but sharing a site with someone does: see [[Sharing]].

## Markdown sites and private pages

On a Markdown site, the rules decide which pages are public, and the pages are rendered again whenever the rules change. Lists of pages, tag pages and the feed only ever name pages the visitor can see, so a public page never leaks the title of a private one, and a shared page shows only shared and public pages. The feed lists public pages only.

Front matter can't make a page public. A page marked `access: private` that a rule would make public is refused until you fix one or the other, or confirm it.

Passa writes the rules into the site as `_passa/access.yml`, a read-only copy. It's there for when the folder is taken out of Passa: `passa render` and `passa serve` use it to build only the public pages.

## Names and search engines

A site's ID address (`k3x9q2.example.com`) is never indexed by search engines. A site with a name (`notes.example.com`) is: its public pages can appear in search results. To keep a page out, add this to its HTML, or to a theme's layout:

```html
<meta name="robots" content="noindex">
```

Names are first come, first served. When a name changes or is removed, the old name keeps redirecting for a while (seven days by default), and only you can claim it again during that time.

## Social cards

Public pages get a social card: the image shown when a link is shared. Private and shared pages don't, since the services that fetch previews can't sign in. See [[Social cards]].
