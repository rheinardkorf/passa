// The theme contract, version 1 (R80, R81): what `theme_guide` returns and
// `passa theme guide` prints. Agents write themes from this alone.
import { DEFAULT_CARD } from './theme.ts';

export const THEME_CONTRACT_VERSION = 1;

export const THEME_GUIDE = `# Passa theme guide

Passa turns a site's Markdown into pages when it's published. A theme decides how those pages look. A theme is just files in the site, so you write it like any other content.

## Files

\`\`\`
_layouts/default.html         the layout for every page, unless a more specific one exists
_layouts/home.html            optional: the home page (/), whether generated or an index.md
_layouts/essay.html           optional: pages whose kind is essay (350 prose words or more)
_layouts/note.html            optional: pages whose kind is note (under 350 prose words)
_layouts/<kind>.html          optional: pages whose front matter says kind: <kind>
_layouts/index.html           optional: the generated home page (sites without an index.md), if there's no home.html
_layouts/tag.html             optional: the generated page for each tag, at /tags/<tag>/
_layouts/deck.html            optional: slides (layout: deck); Passa has a plain built-in one
_layouts/<name>.html          optional: chosen by a page's front matter, layout: <name>
_layouts/partials/*.html      pieces shared between layouts: {{> header}} includes partials/header.html
_layouts/widgets/<name>.html  optional: how a widget renders (replaces a built-in, or adds a new one)
_layouts/card.html            optional: the social card for link previews (see Social cards); Passa has a built-in one
_layouts/fonts/*.woff         the card's fonts, named Family__weight__style.woff (also .ttf, .otf)
theme.css (or any path)       CSS, fonts, images and scripts, served at their own paths
\`\`\`

Which layout a page gets: front matter \`layout:\`, then \`home\` for the page at \`/\`, then \`index\`/\`tag\` for generated pages, then a layout named after the page's \`kind\`, then \`default\`. Unused layouts can be left out: a theme with only \`default.html\` is complete.

## Templates

Layouts are [Mustache](https://mustache.github.io/mustache.5.html) templates: logic-less, no code. \`{{x}}\` is HTML-escaped. \`{{{content}}}\` inserts the page's rendered HTML. \`{{#list}}…{{/list}}\` repeats for each item; \`{{#flag}}…{{/flag}}\` shows when the value is truthy (an object section, like \`{{#featured}}\`, also makes that object the scope); \`{{^flag}}…{{/flag}}\` when it isn't. \`{{#list.length}}\` tests that a list isn't empty.

**Scope.** Inside a section, names resolve against the item first, then outward. So inside \`{{#pages}}\`, \`{{title}}\` is that item's title, and inside \`{{#hero}}\`, \`{{title}}\` is \`hero.title\`, or the page's title if the hero has none. Two habits avoid surprises:
- Reach the current page through **\`page\`**, which nothing shadows: \`{{page.title}}\`, \`{{page.isHome}}\`, \`{{page.url}}\` work anywhere.
- Inside an object section, use full names (\`{{hero.title}}\`, not \`{{title}}\`) when a missing value shouldn't fall back to the page's.

Mustache has no "or" and no "first N": use the values Passa provides (\`hasPager\`, \`recent\`, \`featured\`/\`rest\`).

## Values every layout gets

**The page** (also available as \`page.<name>\`)
- \`title\`, \`url\`, \`content\` (rendered HTML; not under \`page\`)
- \`absoluteUrl\`: the page's full address, and \`socialImage\`: an absolute image URL for link previews (front matter \`socialImage\`, else, on a public page, its social card, else \`cover\`, else \`hero.image\`; null if none). Use them for Open Graph tags in \`<head>\`: \`og:title\`, \`og:url\`, \`og:description\`, \`og:image\` (with \`twitter:card\` \`summary_large_image\` when there's an image)
- \`showTitle\`: true when the body doesn't start with its own \`# Heading\`. When it's false, that heading is already in \`content\`: don't print \`title\` too
- \`isHome\` (the page at \`/\`), \`isPage\` (from a Markdown file), \`isIndex\` (the generated home page), \`isTag\` (a tag page; \`tag\` is its name)
- \`date\` (ISO), \`dateText\` (YYYY-MM-DD), \`dateLong\` ("31 October 2026"), \`dateShort\` ("31 Oct 2026"), \`year\`, formatted in \`site.locale\`
- \`description\`, \`excerpt\` (the description, or the first paragraph that reads as prose, up to about 220 characters)
- \`readingTime\` (minutes), \`words\` (prose only: code and widgets don't count), \`kind\` (front matter \`kind:\`, else \`deck\` for \`layout: deck\`, else \`essay\` at 350 prose words or more, else \`note\`), \`isEssay\`, \`isNote\`, \`isDeck\`
- \`author\` (front matter, else \`site.author\`)
- \`cover\` (an image from front matter, path resolved), \`accent\` (a colour from front matter)
- \`tags\`: \`[{ name, url }]\`
- \`toc\`: \`[{ id, text, level }]\` for the page's \`##\` and \`###\` headings; \`hasToc\` is true with three or more
- \`hero\` (front matter, optional): \`{ title, text, image }\`, the page's opening. \`image\` is resolved like \`cover\`. A theme shows \`hero.title\` (or \`title\` when it has none) as the page's main heading instead of \`title\`, and \`hero.text\` as its standfirst. When a page has a hero and its body starts with a \`# Heading\`, Passa removes that heading from \`content\` (it's still the title), so it never shows twice. Whether \`cover\` also shows is the theme's choice
- every other front matter field, as written

**Lists of pages.** Each item has the page fields above (\`title\`, \`url\`, \`dateLong\`, \`excerpt\`, \`readingTime\`, \`cover\`, \`tags\`, \`isNote\`, \`author\`, …), except \`content\`, \`toc\`, \`hero\` and other front matter. Lists only ever include pages the visitor of this page is allowed to see. The home page is never in a list, and pages marked \`hidden: true\` or \`unlisted: true\` render but never appear in lists or the feed.
- \`pages\`: the site's other listed pages, newest first (on a tag page: the pages with that tag). \`pageCount\`, and \`onePage\` when there's exactly one
- \`featured\`: the first of \`pages\`, a single page (or null when there are none); \`rest\`: the others
- \`recent\`: the first five of \`pages\` (\`site.recentCount\` changes the five)
- \`years\`: \`pages\` grouped by year: \`[{ year, count, one, isUndated, pages }]\`; pages without a date are grouped last, under \`site.undated\` (default "Undated")
- \`backlinks\`: pages that link to this one
- \`related\`: up to three pages sharing the most tags
- \`prev\` and \`next\`: the previous (older) and next (newer) dated page; \`hasPager\` is true when either exists
- \`allTags\`: \`[{ name, url, count, one, pages }]\`

Put the full archive (\`pages\`, \`years\`) on the home, archive or tag pages, not in a sidebar on every page: sidebars use \`recent\`, \`related\` and \`prev\`/\`next\`. Listing every page on every page makes every page as large as the whole site.

**Positions.** Every item in every list (page lists, \`tags\`, \`toc\`, \`nav\`, \`years\`, \`allTags\`, widget \`items\`, \`sections\`) has \`index\` (from 1), \`indexPadded\` ("01", "02", for numbered styles), \`isFirst\` and \`isLast\`. \`featured\` is \`index\` 1, and \`rest\` continues from 2, so one running number works across both. \`isFirst\` is only true for the first item of a list; inside a list that doesn't have positions, \`{{#isFirst}}\` would read an outer value, which is why every list has them.

**Plurals.** \`one\` is true when a count is exactly 1: \`{{count}} {{#one}}piece{{/one}}{{^one}}pieces{{/one}}\`. For the page list, \`{{pageCount}}\` with \`onePage\`.

**Sections.** \`sections\`: the page's content split at each thematic break (a \`---\` line with a blank line above it), as \`[{ content, index, isFirst, isLast }]\`, and \`sectionCount\` for "3 / 6". Used for slides (\`{{#sections}}<section>{{{content}}}</section>{{/sections}}\`), and by any layout that wants the content in parts. A \`> [!notes]\` callout is a convention for speaker notes, which a deck layout hides.

**The site** (\`site\`, from \`_site.yml\`)
- \`site.title\`, \`site.description\`, \`site.author\`, \`site.url\`
- \`site.nav\` (also \`nav\`): \`[{ title, url, current }]\`. \`current\` is true on the page a link leads to and pages under it; a link to \`/\` is current only on the home page. An item can have its own \`items\` (the same shape), making it a section, for a sidebar: \`{ title: Guides, items: [{ title: Access, url: /access/ }] }\`. A section is \`current\` when one of its items is, and may have a \`url\` of its own
- \`navPrev\`, \`navNext\`: \`{ title, url }\` of the pages before and after this one in the nav's reading order (every link, sections included, top to bottom), or null. For "Next: …" links in documentation; \`prev\`/\`next\` follow dates instead
- \`feed\`: the feed's URL (\`/feed.xml\`) when the site has one, else null. Link to it only inside \`{{#feed}}…{{/feed}}\`, and add \`<link rel="alternate" type="application/rss+xml" href="{{feed}}">\` to \`<head>\` the same way: a site whose public pages have no dates has no feed
- \`lang\`: the page language for \`<html lang="{{lang}}">\` (\`site.lang\`, else \`site.locale\`, else \`en\`)
- optional: \`site.locale\` (dates; default \`en-GB\`), \`site.undated\`, \`site.recentCount\`, \`site.logo\`, and any other field in \`_site.yml\`

**Inline Markdown.** \`{{#markdown}}{{hero.text}}{{/markdown}}\` renders a value as inline Markdown (links, emphasis, wikilinks), in layouts and widgets alike. Without it, values are plain text.

**Diagrams.** \`mermaid\` is the Mermaid module's URL when the page has a diagram. Include this once, near the end of \`<body>\`:

\`\`\`html
{{#mermaid}}<script type="module">import mermaid from '{{{mermaid}}}'; mermaid.initialize({ startOnLoad: true });</script>{{/mermaid}}
\`\`\`

To match your theme, use \`theme: 'base'\` with \`themeVariables\` (for example \`{ primaryColor, primaryTextColor, lineColor, fontFamily }\`), and pick values by \`matchMedia('(prefers-color-scheme: dark)')\`.

## What \`content\` contains

Standard Markdown, plus:

| Markdown | HTML to style |
| --- | --- |
| headings | \`h1\`–\`h6\` with \`id\`s |
| \`> [!note] Title\` callouts (note, tip, warning, danger, notes, …) | \`blockquote.callout.callout-<kind>\` starting with \`p.callout-title\` |
| widgets (fenced blocks, below) | whatever the widget's template outputs |
| fenced code | \`pre.hljs[data-lang] > code.language-<lang>\` with highlight.js token classes (\`.hljs-keyword\`, \`.hljs-string\`, \`.hljs-comment\`, \`.hljs-title\`, \`.hljs-number\`, …). \`pre[data-lang]::before { content: attr(data-lang) }\` shows the language |
| \`- [x] task\` | \`li.task > input[type=checkbox]\` |
| \`[[wikilinks]]\` | \`a.wikilink\`; a link to a missing page is \`span.wikilink.missing\` |
| tables, footnotes | \`table\`; \`section.footnotes\` |
| images | \`img\` (already pointing at the right path) |
| \`---\` | \`hr\` (and a break between \`sections\`) |

Raw HTML in the Markdown passes through as written, so \`content\` can hold embeds such as a YouTube \`<iframe width="560">\`: cap them (\`iframe, video, embed { max-width: 100% }\`) so they never cause sideways scrolling on a phone. Give \`pre\` \`overflow-x: auto\`, and remember a scrolling box clips anything positioned outside it, such as a language label. \`pre.mermaid\` has no \`data-lang\`.

The body is flat: no layout containers, nothing nests. A page's structure comes from its layout and front matter; richer pieces are widgets.

## Widgets

A fenced block whose name is a widget renders through a template instead of showing as code. Its contents are data: YAML (a list becomes \`items\`, a map gives its own fields), except where noted. Options after the name are passed as \`options\`: \`\`\`\` \`\`\`stats columns=4 \`\`\`\` gives \`options.columns\` = \`"4"\`. Any other fence name stays a code block. Built-in classes all start with \`w-\`, so a theme's own class names (\`.card\`, \`.grid\`) never collide with them.

| Widget | Writes | Default HTML |
| --- | --- | --- |
| \`cards\` | a list of \`{ title, text }\` (inline Markdown, so \`title: "[[Page]]"\` links) | \`ul.w-cards > li.w-card > p.w-card-title + p.w-card-text\` |
| \`stats\` | a list of \`{ label, value }\` | \`dl.w-stats > div.w-stat > dt + dd\` |
| \`chart\` | \`type: bar\\|line\`, \`title\`, and \`labels\` + \`series: [{ name, values }]\`, or \`values: { label: n }\` | \`figure.w-chart.w-chart-<type> > figcaption + svg + ul.w-chart-legend\` (below) |
| \`gallery\` | one \`![caption](image)\` per line | \`div.w-gallery > figure > img + figcaption\` |
| \`timeline\` | one \`when: what\` per line | \`ol.w-timeline > li > span.w-when + span.w-what\` |
| \`mermaid\` | a Mermaid diagram | \`pre.mermaid\` (becomes an SVG in the browser; see Diagrams) |

**Charts** are drawn as SVG when the site is published: no script, and they work in feeds.
- Every mark uses \`currentColor\`: set \`color\` on \`.w-chart\` for the main colour.
- Each series is \`g.w-chart-series.w-series-N\`; its legend swatch is \`span.w-swatch.w-series-N\`. Colour a series with \`.w-series-2 { color: … }\`, which colours its marks and swatch together.
- Gridlines are \`line.w-chart-grid\` (stroke), axis text is \`text.w-chart-axis\` (fill, font).
- Passa's defaults (series fading in opacity, larger axis text under 600px wide, the legend's layout) have zero specificity, so any rule of yours wins. When you colour series, set \`opacity: 1\` on them if you don't want the fade.
- The SVG is 640 units wide and scales to its container, so text in it scales too.

**Your own widgets.** Add \`_layouts/widgets/<name>.html\` (a Mustache template) and writers can use \`\`\`\` \`\`\`<name> \`\`\`\`. The same file name replaces a built-in's HTML. A widget template gets the widget's data, \`options\`, \`site\` and the \`markdown\` lambda. Built-ins give their template: \`cards\`/\`stats\` \`items\`; \`chart\` its fields plus \`svg\` (the drawn chart, \`{{{svg}}}\`); \`gallery\` \`items: [{ src, alt }]\`; \`timeline\` \`items: [{ when, what }]\` (\`what\` is HTML: \`{{{what}}}\`); \`mermaid\` \`code\`. List the widgets your theme adds in an HTML comment in \`_layouts/default.html\`, after \`<!doctype html>\` (anything before the doctype breaks rendering), with an example of each. The comment is a Mustache template too, so it must not contain \`{{\`; write braces as \`{ {\` or describe the fields in words.

## Rules

- Inline \`style=""\` attributes are allowed.
- Pages are served with a strict Content Security Policy. Scripts, styles and fonts may come from the site itself and from \`cdn.jsdelivr.net\`, \`cdnjs.cloudflare.com\`, \`unpkg.com\`, \`fonts.googleapis.com\` and \`fonts.gstatic.com\`. Inline \`<style>\` and \`<script>\` are allowed. Images and media must come from the site itself (or \`data:\` URLs). Pages can't make network requests (no \`fetch\`) and forms can't post anywhere.
- Every layout must be a complete HTML document.
- Include \`<meta name="viewport" content="width=device-width, initial-scale=1">\`. Pages must work at phone width (390px) with no sideways scrolling.
- Support light and dark (\`prefers-color-scheme\`), unless the design is deliberately one or the other.
- Pages without a cover, date, tags or headings must still look finished.

## Social cards

When a public page is shared (Slack, Bluesky, LinkedIn, iMessage), the preview shows its social card: a 1200×630 image. Passa draws one for every public page without its own \`socialImage\`, from the theme's \`_layouts/card.html\` or the built-in card, and gives the page its URL as \`socialImage\`. Private pages get none: crawlers can't sign in. A card is drawn again only when something it shows changes.

\`passa render\` draws the same cards locally, as \`_card-<hash>.png\` beside each page. Send them with the site and Passa keeps the ones its pages name, so it needn't draw them. The names match when the local build matches what Passa renders: the same files, the site's title in \`_site.yml\`, and \`--site-url\` set to the site's address if the card shows a URL.

### The template

\`_layouts/card.html\` is a Mustache template with the same values as the page's layout (\`title\`, \`description\`, \`excerpt\`, \`kind\`, \`dateLong\`, \`year\`, \`readingTime\`, \`tags\`, \`cover\`, \`hero\`, \`site.*\`, \`page.*\` and any front matter). It's one HTML element, 1200×630, written for **Satori**, which lays out HTML and CSS without a browser, with rules a browser doesn't have:

- **The root element** must be \`width:100%; height:100%; box-sizing:border-box\`. Otherwise padding adds to the size and content runs off the card, with no error.
- **Every element with more than one child needs \`display:flex\`** (Satori's only layout model: no grid, floats or inline-block). Differently styled text goes in separate \`<span>\`s in a flex row.
- **Inline styles only:** \`style="…"\` on each element. No \`<style>\`, classes or external CSS.
- **Supported:** flexbox (\`flex-direction\`, \`justify-content\`, \`align-items\`, \`gap\`, \`flex-grow\`, \`flex-wrap\`), \`padding\`, \`margin\`, \`width\`/\`height\` (px or %), \`position: absolute\` with \`top\`/\`left\`/\`right\`/\`bottom\`, \`border\` and \`border-radius\`, \`background-color\`, \`background-image\` with \`linear-gradient\`/\`radial-gradient\` (and \`background-size\`/\`background-repeat\` for patterns), \`box-shadow\`, \`opacity\`, \`transform\`, \`clip-path\`, \`color\`, \`font-family\`, \`font-size\`, \`font-weight\`, \`font-style\`, \`line-height\`, \`letter-spacing\`, \`text-transform\`, \`text-align\`, \`text-decoration\`, \`white-space\`, \`word-break\`, \`rgba()\`.
- **Not supported:** grid, \`calc()\`, CSS variables, \`@media\`, animations, \`filter\`, pseudo-elements.
- **Long titles:** text wraps on its own; centre it with flexbox. CSS can't shrink text to fit, so pick one size that fits three lines and cut runaway titles with \`line-clamp: 3\` (that element needs \`display:block\`, the one exception to flex).
- **Images:** only the site's own files, by path, with \`width\` and \`height\`: \`<img src="/images/logo.png" width="120" height="120">\`. Passa embeds them; a card naming any other image refuses the publish.
- **Gradients and patterns** take two to four times as long to draw as flat colour. Fine for a few pages; on a large site, prefer flat colour.

### Fonts

Cards can't use web or system fonts: the theme ships its own, in \`_layouts/fonts/\`, named \`Family__weight__style.woff\` (for example \`_layouts/fonts/Space Grotesk__700__normal.woff\`), and \`font-family\` uses the family name. \`.woff\`, \`.ttf\` or \`.otf\`, not \`.woff2\`. A theme card with no fonts refuses the publish, since its text wouldn't render. Open-licence fonts are in npm's \`@fontsource\` packages (\`files/<font>-latin-<weight>-<style>.woff\`).

### Good cards

- The title is the hero: large, high contrast, legible at a quarter of the size in a feed.
- The site's name or mark is on every card, so a share is recognisable.
- It looks like the site: the same palette, type and character.
- Cards for pages without a date, tags or description still look finished.
- Keep detail away from the outer 40px, which some apps crop.

The built-in card, as a starting point:

\`\`\`html
${DEFAULT_CARD}
\`\`\`
`;
