---
title: Themes
description: A theme is a few files in the site — Mustache layouts and CSS — so you write it like any other content.
access: public
---

# Themes

Passa renders Markdown sites with a plain default theme. A theme of your own is just files in the site:

```
_layouts/default.html     the layout for every page
_layouts/home.html        optional: the home page
_layouts/deck.html        optional: slides
_layouts/card.html        optional: the social card
_layouts/partials/*.html  pieces shared between layouts
_layouts/widgets/*.html   optional: how widgets render
theme.css                 CSS, fonts and images, at any path
```

A theme with only `default.html` is complete. Other layouts are chosen by a page's `layout:` front matter, its kind (`note` or `essay`, by length), or the generated pages they're for (the home page, tag pages).

## Layouts

Layouts are [Mustache](https://mustache.github.io/mustache.5.html) templates: plain HTML with values, sections and partials, and no code.

```html
<!doctype html>
<html lang="{{lang}}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{title}} · {{site.title}}</title>
  <link rel="stylesheet" href="/theme.css">
</head>
<body>
  <nav>{{#nav}}<a href="{{url}}"{{#current}} aria-current="page"{{/current}}>{{title}}</a>{{/nav}}</nav>
  <main>
    {{#showTitle}}<h1>{{title}}</h1>{{/showTitle}}
    {{{content}}}
  </main>
</body>
</html>
```

Every layout gets the page (`title`, `content`, `date`, `tags`, `toc`, …), lists of pages (`pages`, `recent`, `related`, `prev` and `next`, `backlinks`), and the site's settings (`site.title`, `nav`, …). Lists only ever include pages the visitor is allowed to see.

## Rules

- Pages are served with a strict Content Security Policy: scripts, styles and fonts come from the site or a few public CDNs, images from the site itself, and pages can make requests only to their own site (as fragments do).
- Every layout is a complete HTML document, and works at phone width.
- Support light and dark colour schemes.

## The theme guide

The full contract — every value a layout gets, the HTML of each widget, the rules, and the social card format — is the theme guide. It's written so agents can build themes from it:

- An agent connected to Passa reads it with the `theme_guide` tool.
- In a terminal, `passa theme guide` prints it.

Ask an agent for a theme in a few words ("a dark, editorial theme with a serif headline font") and it can build one from the guide, then preview it with `passa serve`.
