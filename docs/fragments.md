---
title: Fragments and sign-in
description: Load parts of a page only for the people allowed to see them, and let visitors sign in from the page.
access: public
---

# Fragments and sign-in

A fragment is a piece of a Markdown site that a page loads after it arrives, for viewers allowed to see it. A public home page can show family members links that nobody else sees. Everyone gets the same page; the fragment is fetched separately, and Passa decides on every request whether to send it, the same way it decides for pages.

A login block puts a sign-in link on a page, and shows who's signed in once someone is.

## An example

A home page that's public, with a section for a `family` tier:

```yaml
# _site.yml
tiers: [family]
access:
  /: [public]
  /family/: [family]
```

The family's links are a fragment, `family/cards.md`:

```markdown
---
fragment: true
---
- [Anna](https://anna.example.com/)
- [Ben](https://ben.example.com/)
```

The home page embeds it, and has a login block:

````markdown
# Home

```login
show_user: true
```

```fragment
src: [[family/cards]]
fallback: Family members see links here.
class: family-cards
```
````

A stranger sees the page, the fallback and a "Sign in" link. A family member signs in from the link, comes back to the page, and sees "Signed in as" their email and the links. Following a link to another site is just a link: that site has its own rules, and may ask them to sign in there too.

## Fragments

A page with `fragment: true` is a fragment:

- It's served at its own address (`family/cards.md` at `/family/cards/`), as its content alone: no layout, no navigation.
- Who can open it is decided by its own path and the site's rules (see [[Access]]), not by the page that embeds it. Put fragments in folders the right tiers open, or give one its own `access` in front matter.
- It's left out of everything that lists pages: folder lists, tags, backlinks, previous and next, the feed. It gets no social card, and search engines are told not to index it.
- It can't be the home page.

## Embedding a fragment

A `fragment` block loads a fragment into the page:

| Field | What it does |
| --- | --- |
| `src` | The fragment, as a wikilink: `[[family/cards]]`. Required |
| `trigger` | When it loads: `load` (the default, as the page loads), `revealed` (when scrolled into view) or `click` |
| `fallback` | Markdown shown until it loads, and to viewers who can't open it. None by default |
| `class` | Class names your theme can style, such as `family-cards` |

The block stays on the page, with its classes, and the fragment loads inside it. Without a fallback, it's empty for viewers who can't open the fragment: if your theme gives it padding or a border, hide it while it's empty with `.passa-embed:empty { display: none }`.

The page's HTML names the fragment's path, so anyone can see that path in the page's source, though not what's in it. Don't put anything secret in a fragment's path.

Publishing refuses a block whose `src` isn't one of the site's fragments, or that it can't read. `passa check` reports the same problems.

## The login block

A `login` block shows a sign-in link to viewers who aren't signed in to the site:

| Field | What it does |
| --- | --- |
| `show_user` | `true`: once signed in, show "Signed in as" and their email. `false` (the default): show nothing once signed in |
| `label` | The link's text. "Sign in" by default |
| `class` | Class names your theme can style |

The link signs in to this site and comes back to the page. As with any sign-in to a site, only people the site has given access to get an email; everyone else sees the same answer. Inside a fragment, the link comes back to the home page.

## Staying signed in

A site's sign-in lasts an hour, then renews through Passa's sign-in without another email while the person's Passa session lasts. When a page stays open past that, or the site's access changes, a fragment's next request renews it: the page reloads once, and the fragment loads. If the person no longer has access, they come back to the page signed out of the site, and see the fallback.

## How it works

Pages with a fragment or a login block load HTMX, a small script Passa serves itself (a fixed version, the same for every site). Pages without either don't load it. Pages may fetch from their own site and nowhere else: the site's content security policy allows requests to its own address, and still blocks other sites, form posts and frames.

`passa serve` previews fragments: without `--include-private`, fragments only some viewers open show their fallback, as they would to a stranger. Previews have no sign-in, so a login block shows its link.

For themes, see [[Themes]]: the `htmx` value, and the classes these blocks use.
