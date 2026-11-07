---
title: Markdown sites
description: Write pages in Markdown; Passa renders them with a theme, lists, tags, a feed and widgets.
access: public
---

# Markdown sites

Send Passa Markdown files and it renders them into pages when the site is published. A site can mix Markdown with HTML, images and any other files.

## Files become pages

| File | Page |
| --- | --- |
| `index.md` | `/` |
| `about.md` | `/about/` |
| `notes/plan.md` | `/notes/plan/` |

Without an `index.md`, Passa makes a home page listing the site's pages. Every tag gets a page at `/tags/<tag>/`, and public pages with a date go into a feed at `/feed.xml`.

## Front matter

Each page can start with YAML front matter:

```markdown
---
title: Quarterly review
date: 2026-10-31
tags: [reports, finance]
description: How the quarter went, in one page.
---

# Quarterly review
…
```

The common fields:

| Field | What it does |
| --- | --- |
| `title` | The page's title; otherwise its first heading, then its file name |
| `date` | Orders pages newest first, and puts the page in the feed |
| `tags` | A list; each tag gets a page |
| `description` | A summary for lists, link previews and social cards |
| `layout` | A layout from the theme, such as `deck` for slides |
| `hidden` | `true` renders the page but leaves it out of lists and the feed |
| `cover`, `hero`, `accent` | An image, an opening title and text, and a colour, for themes that use them |
| `socialImage` | An image to use in link previews instead of the social card |

Any other field is passed to the theme as written.

## Site settings

`_site.yml` holds settings for the whole site:

```yaml
title: Passa
description: Publish what you and your AI agents make.
author: Your Name
url: https://docs.example.com/   # for absolute links and the feed
nav:
  - { title: Home, url: / }
  - { title: Guides, url: /guides/ }
```

## Beyond standard Markdown

- **Wikilinks** link pages by title: `[[Get started]]` links to the page titled "Get started". A link to a page that doesn't exist is reported as a problem.
- **Callouts**, as in Obsidian:

  ```markdown
  > [!tip] A tip
  > Callouts can be note, tip, warning, danger and more.
  ```

- **Tables, footnotes, task lists** (`- [x] done`) and **code** with syntax highlighting.
- **Diagrams** with Mermaid, in a ```` ```mermaid ```` block.
- **Slides:** `layout: deck` makes a page a slide deck, one slide per `---` break.

## Widgets

A fenced block named after a widget renders as that widget; its contents are YAML data.

````markdown
```stats
- { label: Sites, value: 12 }
- { label: Visitors, value: 3.4k }
```
````

renders as:

```stats
- { label: Sites, value: 12 }
- { label: Visitors, value: 3.4k }
```

| Widget | Data |
| --- | --- |
| `cards` | A list of `title` and `text` |
| `stats` | A list of `label` and `value` |
| `chart` | `type: bar` or `line`, `labels` and `series`, or `values` |
| `gallery` | One `![caption](image)` per line |
| `timeline` | One `when: what` per line |
| `mermaid` | A Mermaid diagram |
| `fragment` | `src: [[page]]`: a fragment, loaded for viewers who can open it. See [[Fragments and sign-in]] |
| `login` | A sign-in link, and who's signed in. See [[Fragments and sign-in]] |

Charts are drawn as SVG when the site is published, so they need no script:

```chart
type: bar
title: Pages published
values:
  Mon: 3
  Tue: 5
  Wed: 2
  Thu: 6
  Fri: 4
```

A theme can change how any widget looks, or add its own. See [[Themes]].

## Problems

When a site is published, Passa reports what it found: links to missing pages, widgets with bad data, layouts that don't exist, pages that clash with generated ones. `passa check` reports the same problems locally, and exits with an error if there are any, for CI.
