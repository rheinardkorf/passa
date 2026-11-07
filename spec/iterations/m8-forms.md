# M8: Forms

| | |
| --- | --- |
| **Status** | Approved 2026-11-07 (PR #60) |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: the first site API, so the first time a site's pages write data, through a new origin behind CloudFront |
| **Security-relevant** | Yes: accepts writes from site pages, stores what viewers send, and gives owners a way to read it |

## Summary

A ```` ```form ```` block puts a form on a Markdown page. The block describes the fields, their formats and the attribute each answer is stored under. Signed-in viewers who can open the page can submit it, and the answers are stored for that site. A form takes answers once, lets people see and change their answer, or takes as many answers as they like. Owners read the answers through a tool and the CLI, and can export them.

Forms are the first **site API**: Passa's own fixed backend at `/_passa/api/`, called by a site's pages on their own origin. They're the base for later polls, quizzes, RSVPs and comments. No site runs its own server code.

M7 is the groundwork: HTMX, `connect-src 'self'`, quiet refusals, cookie refresh through `auth.`, and the viewer's email in the signed site cookie.

## Terms

| Term | Meaning | Example |
| --- | --- | --- |
| **Form** | A ```` ```form ```` block: an `id` unique in the site, a mode and fields | `id: lunch` |
| **Field** | One question: the attribute `name` its answer is stored under, a `type`, a label and limits | `name: guests`, `type: number`, `max: 10` |
| **Mode** | How often a person answers: `once`, `edit` (one answer, shown again and changeable) or `many` | `mode: edit` |
| **Response** | One person's answers to a form, with their email and when they sent it | `anna@example.com`, `{attending: yes, guests: 2}` |
| **Definition** | A form as published with the site version, which the API checks every response against | in the version, not the page |

## Scenarios

The family site from M7, with `/family/: [family]`. `family/lunch.md` holds an RSVP:

````markdown
```form
id: lunch
mode: edit
submit: Send
thanks: Thanks, see you there.
fields:
  - name: attending
    label: Coming?
    type: choice
    options: [yes, no, maybe]
    required: true
  - name: guests
    label: How many with you?
    type: number
    min: 0
    max: 6
  - name: note
    label: Anything we should know?
    type: textarea
    max: 500
```
````

And `family/name-the-dog.md` holds a `once` form, and `family/guestbook.md` a `many` form.

| Person | Grants | On `/family/lunch/` | On the `once` and `many` forms |
| --- | --- | --- | --- |
| The owner | (owns the site) | the form; can answer like anyone; reads all answers with `passa responses` | the same |
| anna@example.com, first visit | membership: `family` | an empty form; sends it, sees the thanks | answers the `once` form; signs the guestbook |
| anna@example.com, a week later | membership: `family` | the form filled with their answer; changes `guests` to 3; the old answer is replaced | `once`: "You've answered this", with their answer; guestbook: an empty form again, each entry kept |
| anna@example.com, cookie an hour old | membership: `family` | the form loads after a refresh through `auth.` (M7 R175) | the same |
| A stranger | none | sign-in (the page is the family's) | the same |
| A former member, removed | none | sign-in, then no access; their earlier answers stay for the owner until deleted | the same |
| A script on a sibling site (`*.example.com`) posting to the API | the viewer's cookie isn't sent cross-origin, and the request has the wrong `Origin` | refused | refused |

A form on a public page works the same for signed-in viewers. Everyone else sees a sign-in link in its place. Sign-in only works for people the site has granted something, so a public site with no grants takes answers only from its owner. Anonymous forms are later.

## Demo

On dev, on the family site: anna answers the RSVP, comes back, sees the answer and changes it. The `once` form refuses a second answer. The guestbook takes three entries. The owner runs `passa responses <site> lunch --csv` and gets one row for anna, with the changed answer. A `curl` POST with a forged `Origin`, without `HX-Request`, with a field the definition doesn't have, or from a removed member, is refused each time.

## Scope

**In:** the form block and its fields; definitions published with the version; the API for loading and submitting forms; storing responses; the three modes; tools and CLI commands to list forms, read, export and delete responses; limits and rate limits; docs and the theme guide.

**Out:**

- Anonymous forms, and sign-up through a form (abuse controls first).
- Showing totals or other people's answers (polls), answer keys and scores (quizzes), comments: later site APIs built on responses.
- Uploads in forms.
- Emails or webhooks when a response arrives.
- Forms that work without scripts (`form-action 'none'` stays).
- A theme replacing a form's markup (themes style it by class; templates for it later).
- Plain HTML sites using the API directly.

## Requirements

### The form block

- **R180** A ```` ```form ```` block in a Markdown page is a form. Its YAML has `id` (lowercase letters, digits and `-`, unique in the site), `mode` (`once`, `edit` or `many`; `once` by default), `fields`, and optional `submit` (the button's text, "Send" by default), `thanks` (Markdown shown after sending) and `fallback` (Markdown shown in its place to viewers not signed in, a sign-in link by default).
- **R181** Each field has a `name` (the stored attribute: a lowercase letter, then letters, digits and `_`, at most 40 characters, unique in the form, and not `email`, `at` or `id`), a `type`, a `label`, `required` (false by default), and the type's limits:

  | Type | Answer | Limits |
  | --- | --- | --- |
  | `text` | one line | `max` characters (200 by default) |
  | `textarea` | several lines | `max` characters (2,000 by default) |
  | `number` | a number | `min`, `max`, `step` (1 by default) |
  | `choice` | one of `options` | `options` (required) |
  | `choices` | some of `options` | `options` (required), `max` picks |
  | `checkbox` | true or false | |
  | `date` | a calendar date | `min`, `max` |

- **R182** Render refuses a form with a missing or duplicate `id`, an unknown mode or type, a bad or duplicate field name, a choice without options, more than 30 fields, or limits beyond Passa's caps. `passa check` reports the same problems.
- **R183** Render publishes each form's definition (id, mode, fields, the page's path) with the site version, where viewers can't fetch it. The page holds only a placeholder: the form's API path, `data-passa-rule` (M6 R167) and the fallback.

### Loading and answering

- **R184** On load, the placeholder asks the API for the form (`GET /_passa/api/forms/<id>`). The API renders it from the live version's definition, as fixed markup with `w-form` classes:
  - `edit`: filled with the viewer's answer, if any.
  - `once`: "You've answered this" with their answer once they have; otherwise empty.
  - `many`: empty.

  A viewer who isn't signed in gets the quiet `204` (M7 R174), so the fallback stays. A stale cookie is refreshed through `auth.` (M7 R175).
- **R185** Submitting sends the answers to `POST /_passa/api/forms/<id>`. The API stores them and answers with the `thanks`, swapped in for the form. A refusal answers `422` with the form again and the problems beside their fields, nothing stored (HTMX 4 swaps 4xx answers in by default).
- **R186** The modes, enforced by the API:
  - `once`: a second response from the same person is refused, even from two tabs at once.
  - `edit`: a response replaces the person's earlier one.
  - `many`: each response is kept, up to a cap per person.
- **R187** A form whose definition leaves the live version stops loading and taking answers (the API answers `204`). Its responses stay until the owner deletes them or the site is deleted. A changed definition applies to new responses only: stored ones keep the fields they were sent with.

### Who may answer

- **R188** The API accepts a request only when all of these hold. Otherwise it stores nothing, and answers as the edge would for that page (the `204`, or the refresh):
  - its `Origin` is the site's own;
  - it has `HX-Request: true`;
  - its site cookie is valid, signed, for this site and the current access version;
  - the cookie opens the path of the page holding the form;
  - the form is in the live version.
- **R189** Every answer is checked against the definition: no fields it doesn't have, required fields present, types and limits kept. The viewer's email comes from their cookie, never from the request body.

### Owners

- **R190** The owner can list a site's forms (each with its mode, the page it's on, its response count and whether it's still live), read a form's responses in pages, export them as CSV, and delete responses: one person's, or the whole form's. These are tools (`list_forms`, `list_responses`, `delete_responses`) with CLI commands (`passa forms <site>`, `passa responses <site> <form> [--csv]`, `passa responses delete <site> <form> [--email …]`).
- **R191** Deleting a site deletes its responses.

### Limits

- **R192** Each response is at most 16 KB. A site holds at most 50 forms with responses and 20,000 responses in all, and a person's `many` responses to one form are capped. Each person may send at most 10 responses a minute to a site. Each refusal says which limit it hit; limits are config, as `rateLimits` are.

## Security and quality requirements

- **The server decides, never the page.** What a form accepts comes from the definition published with the version, not the page's HTML. Editing the page in the browser can't add a field, change a limit or change the mode. Who may answer is checked on every request against the form's page path, as the edge checks pages.
- **Not trusting same-site.** Sibling sites share the parent domain, so browsers treat them as the same site and `SameSite=Lax` doesn't stop their requests. The API requires the site's own `Origin` and the `HX-Request` header. That header can't be sent cross-origin without a CORS preflight, which the API never allows. The site cookie is host-only, so siblings never get it.
- **Escaped on the way back.** Answers shown again (the `edit` form, `once`'s "You've answered this") are escaped. CSV exports neutralise cells starting with `=`, `+`, `-` or `@` (spreadsheet formulas).
- **Responses are personal data.** Only the site's owner reads them, through authenticated tools. They're kept until the owner deletes them or the site is deleted, and the docs say so. The owner can delete one person's responses on request. Responses never appear in logs; metrics count them without content.
- **Bounded.** Size caps, counts and rate limits stop one viewer filling a site's storage. Writes are conditional, so `once` holds under concurrent requests.
- **No code from sites.** The API is Passa's and fixed. Sites describe forms; they never run code on the server.

## Design

- **Render:** the `form` fence parses and checks its YAML (R182), writes the placeholder (`<div class="w-form" hx-get="/_passa/api/forms/<id>" hx-trigger="load" hx-swap="innerHTML" data-passa-rule="…">fallback</div>`), and adds the definition to `_passa/forms.json` in the version. The edge already returns 404 for `/_passa/*`, so viewers can't fetch it. Pages with forms get `htmx`, so layouts load HTMX (M7).
- **The API:** a new Lambda behind a CloudFront behavior for `/_passa/api/*`, through a function URL with origin access control, never cached. It finds the site from the host and its rules and access version from the site record. It checks the cookie with the same signing keys and code as the edge (moved to `@passa/shared`), and reads the live version's `forms.json` from the versions bucket, cached briefly by version.
- **Storage:** a separate table for site data, so it can be backed up, sized and deleted apart from Passa's own records.
  - A response is `SITE#<site>#FORM#<id>` / `RESP#<email>` for `once` and `edit` (written with a condition: absent for `once`), or `RESP#<email>#<ulid>` for `many`.
  - A site's forms and counts are `SITE#<site>` / `FORM#<id>` items, with conditional increments for the caps.
  - Owners page through a form's responses with a query on its partition. Deleting a site queries its forms and then their partitions, never a scan.
- **Tools and CLI:** `list_forms`, `list_responses` (paged, cursors as M6) and `delete_responses` on the MCP server, owner only, with the CLI commands of R190. The CSV is built by the CLI from the pages.
- **Self-hosted (M9):** the API becomes a route in the self-hosted server, and the table a SQLite table.

## Decisions

1. **Signed-in only at first.** All three modes need to know who is answering. Sign-in limits forms to people the site trusts, so anonymous answers (captchas, harder rate limits) wait.
2. **The definition is published, the page is a placeholder.** The API renders the form, so an edit form can show the viewer's answers, and the server checks answers against something viewers can't change.
3. **Responses are keyed by form `id`, not page,** so a form can move between pages and keep its answers.
4. **Scripts required.** Submission is HTMX over `connect-src 'self'`; `form-action 'none'` stays, keeping native form posts closed for every site.
5. **Fixed markup, styled by class.** Theme templates for forms come later, once the markup has settled.
6. **Forms before self-hosted,** while M7 is fresh; M9 ports the API with everything else.

## Early checks

- **The API behind CloudFront:** a function URL with origin access control under `/_passa/api/*` on the existing distribution, with the viewer-request function and its caching rules unaffected for other paths. Lambda POST bodies through origin access control need a signed payload hash; check HTMX's requests pass.
- **Cookie checks shared:** the edge's cookie verification (a CloudFront Function, ES5-style) and the Lambda's run the same tests from one source.
- **HTMX forms:** `hx-post` under `form-action 'none'` and `connect-src 'self'`, validation answers swapped in, and the `204` and refresh paths, in Chrome, Safari and Firefox.

## Starting values

| Setting | Value |
| --- | --- |
| Response size | 16 KB |
| Fields per form | 30 |
| Forms with responses per site | 50 |
| Responses per site | 20,000 |
| `many` responses per person per form | 100 |
| Responses per person per site | 10 a minute |
| `text` / `textarea` default `max` | 200 / 2,000 characters |

## Delivery

1. The form block, its checks and published definitions in render; `passa check`.
2. The API Lambda, its CloudFront behavior, the shared cookie check, loading and submitting, the modes and limits.
3. Tools and CLI commands for forms and responses, CSV export, and site deletion.
4. Docs and the theme guide, then the demo on dev, then production.

## Changes after approval

None yet.

## Done when

- The demo works.
- Tested:
  - each field type and its limits, and render refusing bad forms;
  - the three modes, including `once` under concurrent requests;
  - every refusal of R188: wrong `Origin`, no `HX-Request`, no, stale or other-site cookie, no access to the page, a form no longer live;
  - answers checked against the definition, not the page;
  - the email taken from the cookie;
  - answers escaped when shown again, and CSV cells neutralised;
  - owners listing, exporting and deleting responses, and no one else;
  - limits and rate limits;
  - site deletion removing responses.
