---
title: Access
description: Private by default; rules make folders or whole sites public, open them to members' tiers, or keep them private.
access: public
---

# Access

Every site starts private: only the person who published it can open it, after signing in. Rules change that.

## Rules

A site's access is a list of rules. Each rule is a path — `/` for the whole site, or a folder ending in `/` — and who may open it:

| Access | Who can open it |
| --- | --- |
| `[public]` | Anyone with the link, without signing in |
| `[gold, silver]` | Members of any of those tiers, after signing in |
| `private` | Only you, and anyone you share it with (see [[Sharing]]) |

You always open everything on your own sites. The longest matching rule decides, and anything no rule covers is private, which is the default. So:

```yaml
- { path: /, access: [public] }
- { path: /drafts/, access: private }
```

makes the whole site public except `/drafts/`. You only write `private` to close a folder inside one that's more open, like `/drafts/` here; anywhere no rule covers is private already. An empty list makes the whole site private again.

Tiers are groups of members, such as `gold` and `silver`: rules name them, and you add people to them. See [[Membership]]. To let one person into one path, share it instead: see [[Sharing]].

Changes take effect within seconds, and everywhere within about a minute.

## Making things public needs a yes

Passa refuses any change that would make something public unless the request says the person agreed (`confirm_public`). An agent has to check with you first; the `passa` command asks you in the terminal, or takes `--confirm-public` in scripts. Changes between private and tiers need no confirmation, but sharing a site with someone does: see [[Sharing]].

## Markdown sites and private pages

On a Markdown site, the rules decide which pages are public, and the pages are rendered again whenever the rules change. Lists of pages, tag pages and the feed only ever name pages the visitor can see, so a public page never leaks the title of a private one. A members page lists pages every one of its tiers can open, and a page under a `private` rule lists only that rule's pages. The feed lists public pages only.

### Access in the site's files

A Markdown site can keep its access in its own files, so publishing or syncing the folder sets it, with no access commands. Declare it in `_site.yml`:

```yaml
tiers: [gold, silver]
access:
  /: [public]
  /lessons/: [gold, silver]
  /lessons/draft/: private
```

and a page can differ from its folder in its front matter:

```yaml
---
title: The quiz
access: [silver]
---
```

`tiers` names the site's tiers; rules can only use those. A page's own access is more specific than its folder's, so it wins; a page that agrees with its folder adds nothing. Once `_site.yml` declares `access`, the files are the site's access: `set_access` and `passa access --rule` are refused, and you change the files instead. Making anything public still needs a yes, however it's set.

A site whose `_site.yml` doesn't declare `access` keeps the rules set with `set_access` or `passa access`. On those sites, front matter can't make a page public: a page marked `access: private` that a rule would make public is refused until you fix one or the other, or confirm it.

Passa writes the rules into the site as `_passa/access.yml`, a read-only copy. It's there for when the folder is taken out of Passa: `passa render` and `passa serve` use it to build only the public pages.

## Who can open what

```sh
passa access my-site
passa access my-site --as sam@example.com
```

The first lists the rules, the tiers they name, and every share. The second shows what one person opens and why (public, a membership of which tier, or a share of which path), and the restricted paths they don't, including grants that haven't begun yet. Agents use `list_access`, with `email` for the second.

## Names and search engines

A site's ID address (`k3x9q2.example.com`) is never indexed by search engines. A site with a name (`notes.example.com`) is: its public pages can appear in search results. To keep a page out, add this to its HTML, or to a theme's layout:

```html
<meta name="robots" content="noindex">
```

Names are first come, first served. When a name changes or is removed, the old name keeps redirecting for a while (seven days by default), and only you can claim it again during that time.

## Social cards

Public pages get a social card: the image shown when a link is shared. Pages that aren't public don't, since the services that fetch previews can't sign in. See [[Social cards]].
