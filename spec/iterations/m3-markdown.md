# M3: Markdown as a first-class format

| | |
| --- | --- |
| **Status** | Draft |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: a renderer in the publishing path, a new kind of file (sources), site-wide pages that must respect access rules, and a first command-line tool |
| **Security-relevant** | Yes: generates HTML from publishers' input, combines content from many pages into each page (where private titles could leak), and builds sites outside Passa where nothing enforces access |

## Summary

Publish Markdown and get a good-looking site. Passa renders every `.md` file into a page when a version is published, with a built-in theme that needs no setup. A site can carry its own theme, as logic-less layouts and CSS, which agents can write and refine like any other file. Home and tag pages, backlinks, related pages and a feed are built from front matter and links, and every list is filtered for the audience of the page it's on.

The Markdown stays flat and readable in any editor. Page data lives in front matter; anything richer than prose is a fenced widget with plain data inside (cards, stats, charts, galleries, timelines, diagrams), which themes can restyle or extend. A deck is a page with a deck layout, one slide per section.

Every public page gets a social card, the image link previews show, drawn at publish time from an HTML and CSS template in the theme, so a shared link looks like the site without anyone making images by hand.

Rendering happens at publish time, so a version is still a complete set of static files: the edge doesn't change, rollback covers the rendered pages, and scanning sees the final HTML. The Markdown is kept with each version as source, which the edge never serves.

Passa should be as useful without an agent as with one. The renderer is its own package, and a `passa` command uses it to build and preview a Markdown folder locally, with no account: what it shows is exactly what Passa publishes.

This spec follows two spikes: four rounds of the renderer (a real 36-post blog, three agents each writing a theme from the written contract and revising it as the contract changed, decks, visibility tests across tiers), and three rounds of social cards (SVG templates against HTML templates, four card styles, and an agent designing a new theme and its card from a one-page guide).

## Demo

From Claude on a phone, say "publish this as a page": one `.md` file becomes a styled page. From Claude Code, publish a folder of notes with wikilinks and tags: it gets a home page, tag pages, backlinks and a feed. Ask for a darker, more editorial theme: the agent writes `_layouts/` and CSS from `theme_guide`, and the whole site changes in one update. Fix a typo with an edit to the `.md` file, and the page re-renders. Make one folder private: it leaves every public listing in the same change. Turn a page of notes into slides with `layout: deck`. Share a post's link: the preview shows a card in the site's style.

Without an agent: run `passa serve` on the same folder, offline, and see the same site; run `passa check` and get the problems a publish would report.

## Scope

**In:**

- Rendering `.md` files to pages at publish time, with front matter.
- A built-in default theme, with a default deck layout, used when a site has none.
- Site themes: Mustache layouts, partials and widget templates in `_layouts/`, plus the site's own CSS and assets, written against a versioned theme contract.
- A fixed set of Markdown extensions (R72) and built-in widgets (R76), and widgets a theme defines (R77).
- Site-wide pages: a home page when the site has none, tag pages, backlinks, related pages, previous and next, and an RSS feed, all filtered by visibility.
- Decks: a page's content split into sections at each thematic break.
- Social cards: Open Graph tags, and a 1200×630 PNG per public page from the theme's card template.
- Sources kept with each version and never served, and a read-only copy of the site's access rules kept with them.
- Edits, folder sync, `get_files` and `get_site` working with sources; a `theme_guide` tool.
- The renderer as its own package, and local `passa` commands: `render`, `serve`, `check`, `init`, `theme guide`.

**Out:**

- Plugins, or any publisher code running at render time.
- MDX, or any Markdown dialect of Passa's own; layout containers in Markdown (`:::`) or any nesting.
- Image processing (resizing, formats), search indexes, sitemaps and pagination (later).
- Copying a theme from another site (later; decision 5 says how it will work).
- `passa` commands that talk to a deployment (`login`, `publish`, `sync`, `pull`, …) and admin commands (later, in the CLI work).
- Publishing the render package to npm (later, when someone besides Passa wants it).

## Requirements

### Rendering

- **R67** Every `.md` file in a version is a source, rendered to a page when the version is published: `index.md` becomes the `index.html` of its folder, and `notes/plan.md` becomes `notes/plan/index.html`, served at `/notes/plan/`. Other files are served as they are, so a site can mix Markdown, HTML and assets.
- **R68** A source that would render to a path another file already has (such as `plan.md` beside `plan/index.html`), or to the same path as another source (`plan.md` and `plan/index.md`), refuses the publish, naming both.
- **R69** Front matter (YAML between `---` lines) can set `title`, `description`, `date`, `tags`, `layout`, `kind`, `cover`, `accent`, `hero` (`title`, `text`, `image`), `author`, `draft`, `hidden` (or `unlisted`) and `access`, and any other fields, which layouts can use. A page without a `title` takes it from its first heading, then its file name. `draft: true` keeps the source but renders no page; `hidden: true` renders the page but leaves it out of every list and the feed. Image paths in front matter resolve from the source's folder.
- **R70** Rendering is part of publishing: the rendered pages are written with the version, pass the same checks as any file, and are staged and scanned like other new content. A page whose rendered HTML is the same as in the previous version is copied, not written again. A source and the page rendered from it count as one file toward the site's file limit, so a Markdown site can have as many pages as an HTML one; pages Passa generates (home, tags, feed, `access.yml`) don't count.
- **R71** Every version is rendered whole, from all its sources. Anything that changes rendered output makes a new version: an update, `set_access` (R85) and `set_name` (R84) on a site with sources.

### Markdown

- **R72** The extensions are fixed and defined by Passa: tables, strikethrough, task lists, footnotes, heading anchors, Obsidian-style callouts (`> [!note] Title`), highlighted code (with its language marked), and wikilinks (`[[plan]]`, `[[plan|the plan]]`). Each still reads as plain Markdown.
- **R73** Links resolve to the site's pages: wikilinks by path, file name or title, ignoring case and punctuation; relative links with or without `.md`. Relative links and images are rewritten from the source's folder, so they work from the page's served path. A wikilink that doesn't resolve renders as text marked as missing, and the publish result lists it.
- **R74** Raw HTML in Markdown is allowed, as HTML files are: pages get the same CSP, so they can't send data anywhere.
- **R75** The body is flat: no layout containers, nothing nests. A page's structure comes from its layout and front matter; richer pieces are widgets.

### Widgets

- **R76** A fenced block named after a widget renders through the widget's template instead of showing as code. Its contents are data: YAML (a list becomes `items`, a map its own fields), or one entry per line for `gallery` and `timeline`. Words after the name are options (```` ```stats columns=4 ````). The built-ins are `cards`, `stats`, `chart` (bar or line, drawn as SVG at publish time, so it needs no script and works in feeds), `gallery`, `timeline` and `mermaid` (loaded only on pages that have a diagram, from a pinned version on the CDN allowlist). Any other fence name stays a code block. A widget whose data is invalid renders as a code block and is listed in the publish result.
- **R77** A theme can replace a built-in widget's HTML, or add a widget of its own, with `_layouts/widgets/<name>.html`. Built-in widget classes start with `w-`, so they never collide with a theme's own.

### Themes

- **R78** A site without layouts uses Passa's default theme, built into the page so it needs no files: readable typography, light and dark, code, callout and widget styles, and navigation between pages, plus a default deck layout (one slide per section, keyboard navigation, speaker notes hidden).
- **R79** A site's theme is its `_layouts/` folder: Mustache layouts, partials (`_layouts/partials/`) and widget templates (`_layouts/widgets/`), plus any CSS and assets the site serves itself. Layouts are sources, never served. A page's layout is its front matter `layout`, then `home` for the page at `/`, then `index` or `tag` for generated pages, then one named after the page's `kind` (front matter `kind`, else `essay` at 350 prose words or more, else `note`), then `default`. A layout a page names that doesn't exist refuses the publish.
- **R80** What layouts receive is the theme contract, version 1, documented in full by `theme_guide`: the page's values (also under `page`, which list items never shadow); lists (`pages`, `featured`/`rest`, `recent`, `years`, `backlinks`, `related`, `prev`/`next`, `allTags`), each item with its position (`index`, `isFirst`, `isLast`); formatted dates in the site's locale, counts with plural flags, `sections`, the site's settings from `_site.yml` (title, nav with the current item marked, language), and a `markdown` lambda for inline Markdown. Additions keep version 1 working; anything that would break a version 1 theme needs a new version.
- **R81** `theme_guide` returns the theme contract, the extensions and widgets with the HTML they produce, the rules (CSP, phone width, light and dark), and the default theme's layouts and CSS, so an agent can make a theme from it alone.

### Site-wide pages and access

- **R82** One rule decides what a page may name, for every list, backlink, related page, previous and next, and tag page: a page's visitors see public pages and pages of the page's own tier; owner-only (private) pages see everything. No other tier includes another, so a shared page never names an owner-only or paid page, and a paid page never names a shared one. The home page is never in a list.
- **R83** A site with no `index.md` and no `index.html` gets a generated home page. A plain file always wins over a generated one: a site's own `index.html`, `feed.xml` or tag page is kept, and nothing is generated in its place. Each tag gets a page at `/tags/<tag>/` only if that page's own visitors can see a page with the tag, so a tag used only on private pages never gets a public page naming it.
- **R84** When a site has dated public pages, it gets an RSS feed at `/feed.xml` of its 50 newest, with absolute URLs at the site's address. `set_name` on a site with sources re-renders it, so the feed and absolute links follow the name.
- **R85** Because listings depend on rules, `set_access` on a site with sources re-renders it in the same change as the rules: there's no moment when a public page lists a page that's private.

### Sources, access files and tools

- **R86** Sources (`.md` files, `_layouts/**`, `_site.yml`) are stored with the version under `_passa/src/`, which the edge never serves (R14). They keep their own paths everywhere else: `get_site` lists them as sources, and `get_files` returns them.
- **R87** `edits` apply to sources; editing a rendered page is refused, with a pointer to its source. Folder sync compares the folder with the version's sources and plain files, never with rendered pages.
- **R88** Every version of a site with sources carries a read-only copy of the site's access rules, `_passa/access.yml`, which `get_files` returns, so a folder taken out of Passa knows what's public. Editing or uploading it changes nothing and is ignored; access changes only through `set_access`.
- **R89** Front matter `access` never grants access inside Passa: the rules decide. A page marked `access: private` that the rules would make public refuses the publish, or the `set_access` change, until the front matter is changed or the change is confirmed with `confirm_public`, the confirmation making things public already needs. Other disagreements (a page marked public that the rules keep private) are listed in the result.
- **R90** The publish result lists every problem the render found: missing wikilinks, invalid widget data, access disagreements.

### The render package and local commands

- **R91** The renderer is its own package, with no AWS and no I/O: sources, rules and site settings in; pages, the feed and problems out. Passa's publish step and the `passa` command both use it, so a local build is exactly what Passa publishes.
- **R92** `passa render <folder>` builds a folder of HTML; `passa serve <folder>` previews it on localhost, rebuilding on change; `passa check <folder>` reports the problems a publish would (R68, R73, R79, R89, R90) and exits non-zero if there are any; `passa init [folder]` starts a site (`index.md`, `_site.yml`); `passa theme guide` prints the theme guide. None of them signs in or uses the network.
- **R93** Outside Passa, access is decided by the folder's `_passa/access.yml` if it has one (as Passa would). Without one, a page builds only if its front matter says `access: public`; any other page is left out entirely, from lists, tags and the feed, and links to it render as missing. Only `public` means anything outside Passa. Only files that built pages reference are copied into the output. `--include-private` builds every page, for local preview, and warns that the output isn't protected.

### Social cards

- **R94** Every page gets its absolute address (`absoluteUrl`) and an absolute `socialImage`: front matter `socialImage`, else the page's card (R95), else `cover`, else `hero.image`. The default theme writes Open Graph and Twitter tags from them; the theme guide tells themes to.
- **R95** A theme's `_layouts/card.html` is a Mustache template with the page's values, written for Satori's subset of HTML and CSS. Passa renders it for every public page into a 1200×630 PNG served beside the page (crawlers can't sign in, so private pages get none). The default theme has a card. A card that fails to render is listed in the publish result, and the page falls back to `cover` or no image.
- **R96** Cards use only the theme's fonts (`.woff`, `.ttf` or `.otf` in the theme, with a default in the default theme) and the site's own images: every image a card names is embedded from the version's files before rendering, and nothing is fetched or read from anywhere else.
- **R97** A card is drawn again only when its inputs change (the page's values it uses, the template and its fonts and images); otherwise the previous version's card is copied (R70).
- **R98** `theme_guide` includes the card guide: the values, Satori's CSS rules and limits, fonts, and what makes a good card.

## Security and quality requirements

- **No publisher code at render time.** Markdown is parsed by a fixed pipeline, and layouts and widget templates are logic-less Mustache, which can't run code or read files: a template can only place values Passa gives it. The only function a template can call is Passa's `markdown` lambda. Widget data is parsed as plain YAML (no custom tags).
- **No new way to reveal private pages** (R82, R83, R85). Every list, backlink and tag page goes through the one visibility rule, computed per tier, with tests that fail the build: public pages never name a private page; a private-only tag has no public page and no public mention; shared, paid and owner-only pages see exactly what R82 says; the home page is never listed. An author's own link from a public page to a private one is kept, as an HTML link would be, but Passa never adds a private page's title.
- **Sources can't leak** (R86): a public site's Markdown, front matter, drafts and theme sources are under `_passa/`, which the edge never serves.
- **Front matter can't make a page public** (R89), and can stop one going public by surprise.
- **Local builds are safe by default** (R93): nothing is public outside Passa unless the rules file or the page says so, and a private page's assets aren't copied.
- **Cards can't read or fetch anything** (R96): image references become `data:` URLs from the version's own files before rendering, and the rasteriser is resvg's WebAssembly build, which can't read the file system (the native build reads paths named in an SVG). Cards are drawn only for public pages, from the values the page already shows publicly.
- **Same checks on rendered pages** as on any file: secret scanning, malware scanning, the CSP.
- **Bounded work:** rendering is limited by the existing file count and size limits, with a time limit on the whole render. A site that can't be rendered in time is refused, not half-published.
- **Escaping:** template values are HTML-escaped except rendered content and widget HTML, so front matter can't inject markup into a layout. Chart labels and values are escaped into the SVG.

## Design

### Where rendering happens

```
publish / update / sync / set_access / set_name
  → files arrive (inline, upload or edits), checked as now
  → sources (.md, _layouts/**, _site.yml) separated from plain files
  → render (packages/render): parse every source, resolve links and
    backlinks, render widgets, filter lists by each page's tier,
    apply layouts; collect problems
  → refuse on R68, a missing layout, or an unconfirmed R89 disagreement
  → rendered pages checked like any file
  → version written: plain files and rendered pages at their paths,
    sources and access.yml under _passa/src/
```

### Packages

- **`packages/render`:** the renderer, the built-in widgets, the default theme and the theme guide text. Pure functions; the self-hosted target (M5) runs the same code.
- **`packages/cli`:** the `passa` binary, with the local commands now, and the deployment and admin commands later (they'll talk to the MCP server and to AWS respectively).
- **`packages/mcp`:** calls the renderer when publishing, and serves `theme_guide`.

### The version's file list

`FileEntry` gains a role: `source` (stored under `_passa/src/<path>`, never served), `rendered` (from a source; the entry names it), or none (a plain file). Paths in tools are the authored ones: an agent edits `notes/plan.md`, and sees `notes/plan/index.html` as rendered from it.

### Performance

Measured in the spike (Node, Apple silicon): about 0.56 ms a page, linear, with 2,000 synthetic pages in 1.1 s; the real 36-post blog in about 0.1 s. Lists are built once per tier and indexed (by date, by tag), and the long ones (`pages`, `rest`, `years`, `related`) only when a layout uses them, so post pages don't pay for the archive. A layout that lists every page on every page makes output grow with the square of the site; the theme guide says to keep full archives off every page. Early check 1 confirms this in Lambda.

### Libraries

| Library | Why |
| --- | --- |
| **markdown-it** with **markdown-it-footnote** | Mature, fast, CommonMark. Heading anchors, task lists, callouts, wikilinks and widgets are small rules of Passa's own: each is a few lines, which beats two more dependencies (the usual task-list plugin is unmaintained) |
| **Mustache** (`mustache`) | Logic-less, tiny, no code execution, widely known by agents |
| **highlight.js**, about 30 common languages | Light enough for Lambda |
| **yaml** | Already used for config |
| **Mermaid**, pinned, from `cdn.jsdelivr.net` | Loaded by the page, only when it has a diagram; renders under the site CSP as it is |
| **Satori** (MPL-2.0) | Lays out a card's HTML and CSS (flexbox, wrapping) into SVG without a browser. Agents write HTML and CSS far more easily than SVG layout, and it needs no background image |
| **resvg**, WebAssembly build (MPL-2.0) | Turns the SVG into a PNG. Accurate and fast, no native binary, never reads the disk |

MPL-2.0 is on the licence allowlist for unmodified dependencies: its copyleft covers only the library's own files.

## Decisions

1. **Render at publish time, not per request.** Versions stay static and immutable, the edge stays a CloudFront Function, and every rendered page is scanned. Per-request rendering would need compute at the edge or origin and would make rollback re-render.
2. **A fixed renderer, no plugins.** Running publishers' code would break the security model and make Passa a build service. New extensions and built-in widgets come from Passa, one at a time. A theme's own widgets are templates, not code.
3. **Mustache for layouts.** Logic-less templates can't run code, and agents know Mustache well. Anything a layout needs to compute (lists, positions, plurals, formatted dates) Passa computes and passes in.
4. **Whole-site renders.** Listings, backlinks and the feed need every page anyway, and a site of hundreds of pages renders in well under a second. Unchanged pages are copied rather than rewritten (R70).
5. **Shared themes are copied, later.** When a site can use another site's theme, the theme's files will be copied into each version at publish, so a later change to the other site never changes this one's old versions.
6. **Changes to rules and names re-render** (R84, R85) rather than leaving listings and feeds stale. It costs a version per change, on sites with sources only.
7. **Themes are files.** No theme store or theme settings: an agent makes a theme by writing `_layouts/` and CSS from `theme_guide`. That's what makes "make it look like X" work with any agent. In the spike, three agents wrote three distinct themes, and decks for each, from the guide alone.
8. **Flat Markdown; layout belongs to templates.** The first spike rounds used `:::` containers for heroes, columns and cards. Every theme fought their nesting, and they read badly outside Passa. Front matter carries page data (`hero`), widgets carry structured content, and templates do layout.
9. **Widgets are fences with data.** Fences are the convention every editor and agent already handles (as Mermaid blocks are), and their contents are data a template places, so a theme can restyle or add widgets without code. Charts are drawn at publish time, so they need no script and work in feeds.
10. **Decks are a layout, not a format.** `sections` (the content split at `---`) and a deck layout made three distinct decks in the spike. Other content types (docs, a CV, a portfolio) follow the same pattern: layouts and front matter, not new specs.
11. **One visibility rule for every tier** (R82). The spike's first renderer treated every non-public tier as private, which would have let shared pages name owner-only and paid ones once M6 adds tiers, and built tag pages from all pages, which leaked private tag names. Both are fixed by deciding visibility in one function, per tier.
12. **No shared fragments.** Rendering shared pieces (an archive, a tag cloud) once per tier and pasting them into every page was tried. It saves time only at sizes Passa doesn't serve, gives familiar names a second meaning (a fragment's "recent" includes the current page), and adds a second way to do what partials do. If a real site is ever slow, the renderer can cache a partial's output internally without changing the contract.
13. **The theme contract is versioned and frozen small.** Version 1 is what the spike's last round settled. It grows only when a real site needs something, because the render package and the CLI make it a public interface.
14. **Useful without agents.** The renderer is its own package with no AWS in it (R91), so a local preview is exactly what Passa publishes, and a plain Markdown folder can be built with no account (R92).
15. **Access travels with the source, read-only** (R88). A folder taken out of Passa knows what's public, but changing access stays with `set_access`, so publishing a file can never make anything public.
16. **Outside Passa, public is opt-in** (R93). With no rules file, only pages marked `access: public` build. Inside Passa, front matter never grants access, but a page marked private can't go public without confirmation (R89).
17. **HTML cards, drawn at publish.** The card spike compared SVG templates (faster, but every element needs a fixed position) with HTML and CSS laid out by Satori (flows like a page, and agents know it). Rheinard chose HTML for its flexibility; an agent then designed an on-brand card from the guide in two attempts. Cards are part of M3 because Markdown should arrive as a complete package.

## To check early

Both done before the build (a throwaway function in dev, Node 24 on ARM):
1. **Cold start and render time in Lambda:** the render bundle adds 150–200 ms to a cold start. At 1769 MB, the real blog renders in 0.4 s cold and 2,000 pages in about 3 s, inside the limit (see Starting values).
2. **`theme_guide` size:** the guide, default layouts and widget templates are about 22,000 characters (about 6,000 tokens), comfortably one tool result.

Still to check, before the card step:
3. **Cards in Lambda:** Satori and resvg (WebAssembly) per card at 1769 MB, and the bundle size. Locally a card takes 25–110 ms depending on its CSS (gradients and patterns cost most); with R97's caching only new and changed pages pay, but a first publish of a large public site may need cards drawn just after the publish.

Checked in the spikes: Mermaid renders under the site CSP with no `connect-src`; rendering is linear at about 0.56 ms a page; the real blog renders with all its links; agents write working themes and decks from the guide; the visibility tests pass across public, private, shared and paid tiers.

## Starting values

| Setting | Value |
| --- | --- |
| Render time limit | 10 seconds per version |
| MCP function memory | 1769 MB (one full vCPU): measured in Lambda, a 2,000-page render takes about 3 s, against 5–7 s at 1024 MB; 3008 MB is no faster, since rendering runs on one thread |
| Highlighted languages | about 30 common ones |
| Feed | the 50 newest public dated pages |
| `recent` | 5 pages (`site.recentCount` changes it) |
| Excerpt | the description, else the first prose paragraph, up to about 220 characters |
| Essay or note | 350 prose words (code and widgets don't count) |
| Date locale | `en-GB`, or `site.locale` |
| Mermaid | 12.2.0 from `cdn.jsdelivr.net` |
| Social cards | 1200×630 PNG, public pages only |

## Delivery

1. The early checks.
2. `packages/render` from the spike: front matter, extensions, links, widgets, layouts, lists, the visibility rule, the default theme and deck layout, the theme guide. Unit tests, including the visibility tests.
3. `packages/cli` with the local commands (R92, R93).
4. Publishing with sources: roles in the file list, storage under `_passa/src/`, `access.yml`, rendered pages checked and staged, unchanged pages copied, R68 and R89 refusals.
5. Tools: `get_site` and `get_files` with sources, edits on sources, folder sync against sources, `theme_guide`, problems in results, descriptions.
6. Re-rendering on `set_access` and `set_name`.
7. Social cards: early check 3, Satori and resvg in the render package, the default card, caching (R97), the card guide in `theme_guide`, and cards in `passa render` and `serve`.
8. Deploy to dev, test, deploy to production.

## Done when

- The demo works in production, from Claude on a phone and from Claude Code, and `passa serve` shows the same site offline.
- Tested on dev, including: a site mixing Markdown and HTML, a conflicting path, a draft, a hidden page, a missing wikilink, invalid widget data, a missing layout, a theme with its own widget, a deck, a public page whose backlinks include a private page (it must not show), a private-only tag (no public tag page), making a folder private (it leaves public listings in the same change), a page marked `access: private` under a public rule (refused until confirmed), a rename updating the feed and the cards' links, a shared link's preview showing the card, a card naming a remote image (refused), an unchanged page reusing its card, and a theme with its own card written by an agent from `theme_guide`.
- Locally: `passa render` on a plain folder builds only pages marked `access: public`, and copies only the files they use.
