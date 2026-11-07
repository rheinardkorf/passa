# M7: Fragments and sign-in

| | |
| --- | --- |
| **Status** | Approved 2026-11-07 |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: a new kind of page, pages fetching from their own site at runtime, and a change to the edge's answer when access is refused |
| **Security-relevant** | Yes: widens the site CSP to same-origin requests, changes refusals at the edge, and adds a second way into sign-in |

## Summary

A **fragment** is a piece of a Markdown site that pages load after they arrive, with HTMX, instead of carrying it in their HTML. A fragment is a page without a layout, at its own path, so the site's rules decide who opens it exactly as they do for pages: the edge checks every request. A public page can embed a fragment only family members see, and everyone else gets the page without it. Nothing about the fragment reaches the page's HTML but its path.

A ```` ```login ```` block puts a sign-in link on a page. Once the viewer is signed in to the site, it shows who they are, or nothing, as the author chooses.

Fragments only display. They don't send anything back (no forms, no posts); that belongs to the later site APIs, which this prepares for.

## Terms

| Term | Meaning | Example |
| --- | --- | --- |
| **Fragment** | A Markdown file marked `fragment: true`, rendered without a layout at its own path | `family/cards.md` → `/family/cards/` |
| **Embed** | A ```` ```fragment ```` block in a page, naming a fragment to load | `src: [[family/cards]]` |
| **Fallback** | What an embed shows until its fragment loads, and when it doesn't | `Family members see links here.` (optional) |
| **Login block** | A ```` ```login ```` block: a sign-in link for viewers not signed in to the site; for those who are, who they are or nothing | `show_user: true` |

## Scenarios

One worked example. A personal home site, with a family section:

```yaml
# _site.yml
tiers: [family]
access:
  /: [public]
  /family/: [family]
```

`family/cards.md` is a fragment (a card per family member, each a link to their own site); the public home page embeds it with no fallback, and has a login block with `show_user: true`.

| Person | Grants | Opens `/` and sees | Opens `/family/cards/` directly |
| --- | --- | --- | --- |
| The owner | (owns the site) | the page, the cards, and "Signed in as" their email | the bare fragment |
| anna@example.com, signed in | membership: `family` | the page, the cards, and "Signed in as anna@example.com" | the bare fragment |
| anna@example.com, not signed in yet | membership: `family` | the page, no cards, and a "Sign in" link; after signing in, back on the page with the cards and their email | sign-in, then the bare fragment |
| anna@example.com, an hour later (site cookie expired, auth session still valid) | membership: `family` | the page; the fragment's request passes through `auth.`, which refreshes the cookie, and the cards load | as a private page now |
| A stranger | none | the page, no cards, and the "Sign in" link (following it, they get the same answer as anyone with no grant); never sent to sign-in by the page itself | sign-in |
| A former member, removed | none | the page, no cards (the refresh finds no access and clears the old cookie; no loop) | sign-in, then no access |

The page's HTML is the same for all of them: it names `/family/cards/` and nothing in it, and carries the sign-in link. Who is signed in arrives afterwards, from the edge, only to that viewer. With `show_user: false`, signed-in viewers see nothing where the link was. Following a card's link to anna.example.com is a different site with its own rules, and may need its own sign-in.

## Demo

On dev: a public home page embedding a family fragment. A stranger in a private window sees no cards, only the page's sign-in link; a family member signs in from it and sees the cards and their email; an hour later (or with the cookie's version bumped), the cards still load after a refresh through `auth.`; removed from the tier, the cards are gone on the next load.

## Scope

**In:** fragments in Markdown sites, the embed block, the edge's answer to refused HTMX requests, refreshing site cookies from a fragment request, the login block, the CSP and HTMX itself, the theme guide and docs.

**Out:**

- Sending data (forms, `hx-post`, polls): later, with site APIs. `form-action 'none'` stays.
- Fragments in plain HTML sites; HTML files as fragments.
- Cross-site anything: embedding another site's fragments, or tiers that span sites. A card linking to another site is just a link.
- The apex domain for a home site (a custom-domain question, solved separately).

## Requirements

### Fragments

- **R168** A Markdown page whose front matter says `fragment: true` is a fragment. It renders to its pretty URL (`family/cards.md` → `/family/cards/`) as its content inside a wrapper (`<div class="passa-fragment">…</div>`), with no layout, `<html>`, navigation or theme assets. It can use everything a page's content can: widgets, wikilinks, callouts.
- **R169** A fragment's access is its path's, decided by the site's rules like any page; its front matter `access` makes a rule for it when it differs from its folder (M6 R150). Where it's embedded doesn't change who opens it.
- **R170** Fragments are left out of everything that lists pages: folder lists, tags, backlinks, previous and next, the feed, the sitemap and navigation. They get no social card, and are served with `X-Robots-Tag: noindex`.

### Embedding

- **R171** A ```` ```fragment ```` block embeds a fragment: `src` (a wikilink to a fragment, resolved as wikilinks are), `trigger` (`load`, the default; `revealed`, when scrolled into view; or `click`), and `fallback` (Markdown shown until it loads, and when it doesn't; none by default). It renders as an element with `hx-get` set to the fragment's URL and its rule's ID (`data-passa-rule`, M6 R167), and the fallback inside.
- **R172** Render refuses an embed whose `src` isn't a fragment of the site, or has no `src`. It doesn't warn that some readers can't open a fragment: that's the point. A fragment may embed others; render needn't follow them, since they load at runtime.
- **R173** A page that embeds a fragment or has a login block loads HTMX: a pinned version Passa serves itself, the same for every site, never a publisher's copy. Pages without either don't load it.

### The edge

- **R174** A refused request that says it's from HTMX (`HX-Request: true`) gets no redirect to sign-in. With no site cookie (a stranger), it gets an empty `204`, so the fallback stays and nothing is swapped in. Refusals are `Cache-Control: no-store`. The header changes only the form of a refusal, never whether access is given: anyone can send it.
- **R175** A refused HTMX request that carries the site's cookie, expired or from an older access version (someone who was signed in), gets `HX-Redirect` to `auth.`'s refresh for the page it came from (`HX-Current-URL`, if it's on the same site; else `/`). Refresh hands back a new cookie if the person's `auth.` session is valid and they open something on the site, and returns them to the page; otherwise it returns them to the page with the site cookie cleared, so the next fragment request is a stranger's, with no loop. A signed-in viewer whose cookie is current but doesn't open the fragment gets the `204`.
- **R176** Requests for fragments are otherwise served as pages are: the same rules, cookie checks, headers and caching (the check runs before CloudFront's cache).

### The login block

- **R177** A ```` ```login ```` block renders a sign-in link: `auth.`'s site sign-in for this site and the page's path, with `label` as its text ("Sign in" by default). Signing in from it works for anyone the site has granted something (as now: others get the same answer and no email), and returns them to the page, now with a cookie. The link is in the page's HTML, so it works without scripts. The block also asks the edge, once the page loads, whether the viewer is signed in to the site. A page may have more than one; themes style it by its class (`passa-login`).
- **R178** The edge answers that question at `/_passa/login`, for every site, whatever its rules, with `Cache-Control: no-store`. With no valid, current site cookie, it answers an empty `204` and the link stays. With one, it answers the replacement: "Signed in as" and the viewer's email when the block says `show_user: true`, or an empty element when it says `false` (the default), so nothing shows. The email comes from the viewer's own signed cookie, so it's never anyone else's.

### Content Security Policy

- **R179** Site pages may fetch from their own origin: `connect-src 'self'` replaces `connect-src 'none'`. Nothing else in the CSP changes: no other origins, no form posts, no frames.

## Security and quality requirements

- **The edge decides, never the page.** Whether a fragment loads is decided by the edge on every request, against the fragment's own path. The site cookie is `HttpOnly`, so no script can read a viewer's tiers, and `data-passa-rule` marks only tidy pages.
- **Nothing private in the embedding page.** A page's HTML holds the fragment's path, its rule's ID and the fallback the author wrote; never the fragment's content. The docs say a fragment's path is visible to everyone who opens the embedding page, so it shouldn't say anything secret.
- **No new way to probe access.** A refused HTMX request answers the same whether or not the path exists or the site is private (an empty `204`, as a refusal without the header reveals nothing either). Refresh answers the same whether or not the person has access, as sign-in does.
- **No refusal is cached,** so a member never gets a stranger's empty answer.
- **Who's signed in is told only to them.** `/_passa/login` reads the viewer's email from their own signed cookie and is never cached. A site's scripts can read it once it's on the page; the site's owner already knows it, having granted that person access. It never appears in the page's HTML or any cached response.
- **Same origin only.** `connect-src 'self'` lets a page read what its viewer could open anyway, on its own site, and nothing else; it can't send data to other origins. Sibling sites are other origins.
- **HTMX is pinned and Passa's,** served from one place, so no publisher can swap it, with its version recorded.

## Design

- **Render:** `fragment: true` pages render through a fixed fragment wrapper instead of the layout, and are flagged so lists, the feed, the sitemap and cards skip them. The `fragment` fence is a built-in widget-like block: it resolves `src` with the wikilink resolver, checks the target is a fragment, and writes `<div hx-get="…" hx-trigger="…" hx-swap="outerHTML" data-passa-rule="…">fallback</div>`. The `login` fence writes `<div class="passa-login" hx-get="/_passa/login?show_user=…" hx-trigger="load" hx-swap="outerHTML"><a href="…">label</a></div>`, with the link's site and path fixed at render. Pages with either get a `hasFragments` value, and layouts add the HTMX script when it's set.
- **HTMX:** one pinned file at `/_passa/htmx.js`, served by the edge itself for every site, whatever the site's rules (it's Passa's, not the site's). The edge already reserves `/_passa/`; this adds two public paths beside the handoff (`/_passa/login` too). (Alternative for the early check: the CDN with a Subresource Integrity hash, simpler but dependent on the CDN allowlist, which self-hosters may empty.)
- **Edge:** in the refusal branch, before redirecting, check `HX-Request`; then whether a site cookie was sent at all (signed, for this site) to choose between `204` and `HX-Redirect`.
- **Login:** the site cookie gains the viewer's email (base64url, as a field covered by the cookie's signature and the handoff's), so the edge can answer `/_passa/login` without asking `auth.`. Cookies from before carry no email: they're shown as "Signed in" until their next refresh. The answer's markup is Passa's, fixed, with the email escaped.
- **Refresh:** `auth.`'s `/site/refresh?site=…&path=…`: with a valid session and access, `siteRedirect` as now; otherwise a redirect back to the page through the edge's handoff in a "clear" form that deletes the site cookie. The handoff's signature covers the clear form, so nobody can clear someone else's cookie by link (it's their own cookie on their own browser anyway).
- **CSP:** the shared `contentSecurityPolicy` in `@passa/csp`, used by the edge, infra and the CLI's preview, changes once for every site.
- **The CLI:** `passa render` and `passa serve` build fragments and the embed; `passa serve` serves HTMX locally; `passa check` reports bad embeds.

## Decisions

1. **A fragment is a page with a path,** so the rules, the edge and caching need nothing new for access: where it's embedded doesn't matter.
2. **Refusals are quiet for HTMX,** with no sign-in redirect and no cached answer; a stranger never gets bounced to sign-in by a fragment.
3. **Expired cookies refresh through `auth.`,** with a full-page round trip (about once an hour for an open page), because a fragment's request can't follow a redirect to another origin.
4. **Display only.** Anything that sends data waits for site APIs.
5. **Same-site cards, plain links.** Tiers stay per site (M6); a card is a link, and following it may need another sign-in.
6. **Sign-in is a block the author places,** not something themes add on their own. The link is in the HTML; whether to swap it out is the edge's answer to the viewer, so pages stay cacheable and the same for everyone.

## Early checks

- **HTMX against the edge:** `hx-get` with a `204` (nothing swapped, fallback kept), `HX-Redirect` through refresh and back, under the new CSP, in Chrome, Safari and Firefox.
- **Never cached:** a refusal followed by an allowed request for the same fragment, through CloudFront, gets the content; a member's response never reaches a stranger.
- **Serving HTMX:** from the edge at `/_passa/htmx.js` (size against CloudFront Function limits, or from the version bucket) versus the CDN with SRI.

## Starting values

| Setting | Value |
| --- | --- |
| HTMX | 2.x, pinned (the exact version recorded at build time) |
| Triggers | `load` (default), `revealed`, `click` |
| Swap | `outerHTML` (the embed is replaced by the fragment) |
| Login block | `label: Sign in`, `show_user: false` |

## Delivery

1. Fragments and the embed in render, with lists skipping them; `passa render`, `serve` and `check`.
2. The edge's quiet refusal, the CSP, and HTMX served by Passa.
3. Refresh through `auth.`, the email in the site cookie, and the login block.
4. Docs and the theme guide, then the demo on dev, then production.

## Changes after approval

None yet.

## Done when

- The demo works.
- Tested: a fragment's access following its path, whatever embeds it; fragments left out of lists, the feed, the sitemap and cards; bad embeds refused; a stranger's HTMX request getting a `204` and never a redirect; a stale cookie refreshed through `auth.` and back; a removed member's refresh clearing the cookie without a loop; no refusal cached; the CSP allowing same-origin requests and nothing more; the login block's link returning to the page, and its answer for no cookie, a stale cookie, `show_user: true` and `false`, never cached; the CLI building and previewing fragments.
