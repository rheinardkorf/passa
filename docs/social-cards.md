---
title: Social cards
description: The image shown when a public page is shared, drawn by Passa or by passa render.
access: public
---

# Social cards

When a public page is shared in Slack, iMessage, LinkedIn or Bluesky, the preview shows its social card: a 1200×630 image with the page's title and the site's name. Passa draws one for every public page that doesn't name its own `socialImage`.

Private pages get no card, since the services that fetch previews can't sign in.

## Your own design

A theme can design its own card in `_layouts/card.html`: one HTML element, styled inline, drawn with [Satori](https://github.com/vercel/satori) rather than a browser. The theme ships the card's fonts in `_layouts/fonts/`. The rules are in the theme guide (`passa theme guide`).

## Drawn once

A card is identified by a hash of everything it shows. Passa keeps cards in a store for each site, outside its versions, and only draws a card when nothing in the store matches, so publishing a change to one page doesn't draw the others again.

Passa draws cards for a few seconds while publishing, then finishes the rest in the background. A page whose card isn't drawn yet has none for a minute or so.

## Drawing cards on your own machine

`passa render` draws the same cards locally, as `_card-<hash>.png` beside each page, and `passa sync` sends the ones the site doesn't have yet. Passa checks each is a 1200×630 PNG that one of the site's pages names, then keeps it instead of drawing it.

The names match when the local build matches what Passa renders: the same files, the site's title in `_site.yml`, and the site's address set with `--site-url` if the card shows it.

## A different image

To use any other image for a page's preview, name it in front matter:

```yaml
socialImage: /images/preview.png
```
