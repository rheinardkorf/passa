# M6: membership

| | |
| --- | --- |
| **Status** | Approved 2026-11-07 (PR #55), then changed after its early checks (see Changes after approval) |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Full: named tiers on a site, a new kind of grant, access declared in a site's own files, and a change to how rules and shares are written |
| **Security-relevant** | Yes: decides who besides the owner opens which paths, lets site files set access, and changes how shares reach paths |

## Summary

M5 let an owner share a path with one person. M6 adds **tiers**: named groups on a site, such as `gold` and `silver`, that rules open paths to. The owner adds people to tiers (**memberships**), and everyone in a tier opens what its rules open. Shares stay, for one person and one path, and work whatever the rules say: a course for gold and silver members can still be shared with one reviewer who isn't a member.

Access moves into the site's own files: `_site.yml` sets folders and names the site's tiers, and a page's front matter can set its own. Who is in a tier is never in site files; it lives on the server.

The paywall (M8) then only has to add "a purchase grants a tier", and scheduled access (M9) builds on the start and end dates every grant gains here.

## Terms

| Term | Meaning | Example |
| --- | --- | --- |
| **Rule** | A path, and who may open it | `{ path: /lessons/, access: [gold, silver] }` |
| **Audience** | One entry in a rule's `access` list: `public`, or a tier name | `gold` |
| **Tier** | A named membership group a site defines; names only, no people | `gold`, `silver` |
| **Membership** | A grant: one person in one tier | sam@example.com is in `gold` |
| **Share** | A grant: one person, one path | reviewer@example.com may open `/lessons/` |
| **Grant** | Either kind: "this email may open something" | |

The owner opens everything, whatever the rules say. Private is the default: a path no rule covers opens only to the owner, and to anyone it's shared with. **`private`** is the keyword for an exception, closing a path inside a more open folder:

```yaml
access:
  /lessons/: [silver]
  /lessons/draft/: private
```

`/lessons/` and everything under it open to silver members; `/lessons/draft/` is the owner's alone (plus anyone it's shared with).

## Scenarios

One worked example, to check the requirements against before code does. A Markdown course site:

| Path | Access (from `_site.yml`, or the page's front matter) |
| --- | --- |
| `/` | `[public]` |
| `/lessons/` | `[gold, silver]` |
| `/lessons/bonus/` | `[gold]` |
| `/lessons/week-3/quiz/` | `[silver]` (front matter on that one page) |
| `/lessons/draft/` | `private` |

| Person | Grants | Opens | Doesn't open |
| --- | --- | --- | --- |
| The owner | (owns the site) | everything | |
| sam@example.com | membership: `gold` | `/`, `/lessons/` (every week), `/lessons/bonus/` | the quiz (silver only), `/lessons/draft/` |
| kim@example.com | membership: `silver` | `/`, `/lessons/`, the quiz | `/lessons/bonus/`, `/lessons/draft/` |
| reviewer@example.com | share: `/lessons/` (ends in 90 days) | `/`, `/lessons/` and every week without a rule of its own | `/lessons/bonus/`, the quiz and `/lessons/draft/` (each has its own rule; the share's result names them) |
| lee@example.com | membership: `gold`, from 1 December | `/` until then; as Sam from 1 December | |
| Anyone else | none | `/` | everything else |

Lists follow the same table: the bonus page may list lessons (gold members open both), but a lesson page doesn't list the bonus (silver members open lessons and not the bonus), and nothing lists the draft.

## Demo

A Markdown course site whose `_site.yml` sets `/` public, `/lessons/` to `[gold, silver]`, `/lessons/bonus/` to `[gold]` and `/lessons/draft/` to `private`; one lesson's front matter says `access: [silver]`. Published with `passa sync` and no access commands. `passa members add` puts one address in `gold` and another in `silver`, from a start date, with an end date; each gets an invite. Signed in, the gold member opens the bonus and the silver member doesn't; neither opens `/lessons/draft/`. `/lessons/` is shared with a third address, who opens every lesson but not the bonus or the silver-only lesson, and the share's result says so. `passa access course --as <email>` shows what each person opens, and why. `passa members remove`, and that person's next request is refused.

## Scope

**In:**

- Tiers, and rules that list them.
- Memberships, added and removed by the owner through tools and the CLI.
- Access declared in `_site.yml` and front matter, as the source of truth for Markdown sites.
- Shares that reach a path whatever its rule, stopping at the next rule down.
- Start and end dates on every grant.
- "What can this person see?" from the CLI and a tool.
- Moving existing rules and shares to the new form.

**Out (later):**

- Other ways into a tier: invite links, self sign-up, agents or scripts adding members, and the paywall (M8). Self sign-up needs abuse checks and email to strangers.
- Tiers shared across sites: tiers and rules belong to one site.
- A tier's default duration, and reminder emails before a grant ends.
- Tiers that include other tiers: lists only, so `gold` doesn't include `silver` unless both are listed.
- Previewing a site as a given person.

## Requirements

### Rules and tiers

- **R146** A rule is a path and its access: a list of one or more audiences (`public`, or tier names), or `private`. A path opens to anyone in any listed audience; the longest matching rule decides, and a path no rule covers is private. `private` isn't an audience: it means no audience (the owner, and anyone the path is shared with), and is only written to close a path inside a more open folder, such as `/lessons/draft/` under a silver `/lessons/`. `public` combined with tiers is refused, since it already opens to everyone.
- **R147** A site names its tiers in `_site.yml` (`tiers: [gold, silver]`). A rule may only list named tiers; tier names are 1–30 lowercase letters, digits and hyphens, and `public`, `private` and `shared` are reserved.
- **R148** The owner opens every path of their site, whatever its rules.
- **R149** A site has at most 20 rules, counting folder rules, page rules and the rules shares create (R156), within the edge record's budget (about 850 bytes; with long paths, about 10 rules fit). Over it, the change is refused with which rules to merge.

### Access in the site

- **R150** On a Markdown site, `_site.yml`'s `access` sets rules for folders (`/lessons/: [gold, silver]`, `/lessons/draft/: private`), and a page's front matter `access` (`[silver]`, or `private`) sets a rule for that page's folder. The site's files are the source of truth: publishing or syncing them sets the site's rules, and `set_access` on a Markdown site writes `_site.yml` (making a new version, as rule changes on Markdown sites do now).
- **R151** Anything a change would make public still needs `confirm_public` from an agent, or a yes in the terminal (`--confirm-public` in scripts), whether the change comes from `set_access`, `_site.yml` or front matter. Tiers and `private` need no confirmation. This replaces M3 R89 (front matter never grants access) for tiers.
- **R152** Plain HTML sites keep their rules on the site, set with `set_access` and `passa access`, in the new form.

### Memberships

- **R153** `add_member(site_id, email, tier, starts_at?, expires_at?, confirm_member)` and `passa members add <site> <email> <tier> [--from date] [--expires date | --for 30d] [--yes]` add a person to a tier; `confirm_member` (or the terminal) reads the email back first, as `confirm_share` does. Adding again replaces the dates. The invite says who added them, the site's address and when access begins; never the title or a sign-in token. Invites count against `rateLimits.invitesPerDay`, at most hourly per email and tier.
- **R154** `remove_member(site_id, email, tier?)` and `passa members remove` remove one membership, or every membership of the email, and bump the site's access version, so the person's next request is refused.
- **R155** `list_members(site_id, tier?, cursor?)` and `passa members list` list memberships with their dates, a page at a time. There's no member limit.

### Shares

- **R156** A share opens the rule at its path, and every folder and page under it that has no rule of its own; a folder or page with its own rule is shared separately. When the path has no rule, the share adds one copying the access of the rule above, so nobody else's access changes. The share's result names any paths under it that it leaves out because they have their own rules.
- **R157** A share works whatever the rule's audiences (`public` aside, which needs none). `shared` is no longer an audience.

### Start and end dates

- **R158** Every grant, membership or share, may have a start (`starts_at`, `--from`) and an end (`expires_at`, `--expires`, or `--for` a duration turned into a date when added). Before its start and after its end a grant opens nothing: sign-in and cookie refresh check both, and an ended grant is removed (DynamoDB TTL), bumping the access version, as shares' expiry does now. An end in the past, or not after the start, is refused as almost certainly a mistake.
  - **Memberships** need no end: without one, a membership lasts until it's removed (a lifetime member, say), and an end can be any time ahead.
  - **Shares always end,** since they're ad hoc and easy to forget: 90 days after they're made (or after their start) unless given an end, and at most a year ahead (M5 R133's limit, kept). Sharing again renews a share. This replaces M5's shares without an end.

### Seeing who has access

- **R165** `passa shares` and a `list_shares` tool list every share across the owner's sites (site, path, email, made, start, end, last used), soonest end first, filtered with `--ending 30d` or by site, a page at a time, so shares that are forgotten or no longer used are easy to find and remove.
- **R166** Every grant records when it was last used: the date of the latest sign-in in which it opened something. `list_access`, `passa shares` and `passa members list` show it (`never` until first used).

- **R159** `passa access <site> --as <email>`, and an `email` option on `list_access`, list every path the person opens and why (public, a membership of which tier, or a share of which path), and the restricted paths they don't open.
- **R160** `list_access` lists rules with their audiences, the site's tiers, and shares; `list_members` lists memberships.

### Rendering

- **R161** A page's audience is its rule's audience. A page's lists (pages in a folder, backlinks, tag pages, previous and next) are made for its audience: it lists another page only if everyone in its audience can open that one. Public pages are listed everywhere; a page under a tier rule lists pages whose audience covers its own; a page under a `private` rule lists only pages under that same rule, and public ones; a page with no rule at all (the private default, never shared) lists everything, since only the owner reads it. Shares don't change lists: someone reading a page through a share sees what its audience sees, which can include titles of pages they can't open, but never those pages. Pages that aren't public get no social cards. Render's warnings name links a page's readers can't follow, as now.
- **R167** Render marks every link to a page that isn't public with that page's rule ID (`data-passa-rule`), so a theme or script can later tidy links a viewer can't follow. Nothing uses the marks in M6, and they reveal only a short hash of a path.

### Moving to the new form

- **R162** Existing rules move to the new form: `{ path, tier: public }` → `access: [public]`, `private` → `private`, and M5's `shared` → `private`, kept, since its shares need a rule at their path to open (R156). Existing shares keep working under R156, with their dates as they are; R158's default end applies to shares made from now on. Tools and the CLI accept the old `tier` field for one release, answering in the new form.

### CLI and docs

- **R163** The CLI does everything the tools do: `passa members add | remove | list`, `passa shares`, `passa access --as`, and `--from` / `--expires` / `--for` on `passa share` and `passa members add`.
- **R164** The docs get a Membership page (tiers, memberships, access in `_site.yml` and front matter, how shares and memberships combine, dates), and the Access and Sharing pages move to the new terms.

## Security and quality requirements

- **Making things public is still confirmed,** whichever way access is set (R151).
- **Members are never in site files:** emails stay on the server, never in versions, pulls or folders.
- **Adding a member is confirmed,** reading the email back, as sharing is (R153).
- **No bulk email:** invites count against the daily cap (R153).
- **Lists are made for audiences** (R161): a page's lists show its audience only pages they can all open, and nothing private reaches a list on a page someone else reads. Someone reading a page through a share may see titles (never content) of pages in its lists that they can't open: shares are given for that page, and members come first.
- **Revocation is complete:** removing a membership or share, or its end passing, bumps the access version; site cookies last an hour at most anyway.
- **The owner is never locked out** of their own site (R148).

## Design

- **Rules:** `{ path, access: string[] | 'private' }`, stored on the site as now. The edge record's format is unchanged: every rule that isn't public, `private` ones included, becomes `[path, "s", id]` as M5's shared rules do, so shares on any rule can be opened; audiences stay off the edge. (Today private rules go to the edge as `x`, and none are sent when every rule is private; that changes.)
- **Viewer cookies:** list the IDs of the rules a person opens: rules listing a tier they're a member of (within its dates), and the rule each of their shares opens (R156). `auth.` works them out at sign-in, as now.
- **Memberships:** items in the site's partition (`SITE#<site>`, `MEMBER#<tier>#<email>`), with start, end, invite time and a TTL at the end; one person's are found by a second key (`MEMBERSHIP#<email>#<tier>` in the same partition, or an index), so sign-in reads them directly. Listing a tier is a query, a page at a time.
- **Shares:** as M5 (`GRANT#<email>#<path>`), plus a start date and a required end; a share no longer reaches rules under its path. Listing every share across an owner's sites (R165) needs an index by owner (an overloaded key on the share items, as `gsi1` already does for sites by owner), not a scan.
- **Last used:** `auth.` already reads a person's grants at sign-in to build their cookie; it writes the date back to each grant that opened something, skipping grants already marked today, so it costs a write per grant per day at most, never per page.
- **Access in files:** render reads `_site.yml`'s `access` and `tiers` and each page's front matter into rules, merges page rules that match their folder's, and returns them with the version; publishing stores them on the site. `_passa/access.yml` remains a read-only copy for folders taken out of Passa.
- **Render:** audiences become sets; "may list" is "every audience of the listing page is in the listed page's audience" (with public and owner-only as now).

## Decisions

1. **Tiers and shares are separate grants.** A tier is an audience rules name; a share is one person and one path, and works whatever the rule says, so a reviewer can see a members' course without becoming a member.
2. **A share stops at the next rule down.** A folder with its own rule is a separate decision, so "share the lessons but not the bonus" needs nothing extra, and new folders without their own rule are included.
3. **Lists, not hierarchies.** `gold` doesn't include `silver`; a rule lists every tier it opens to.
4. **The Markdown is the source of truth** for Markdown sites, with page front matter able to differ from its folder; the longest rule wins, so a page's own setting needs no special precedence.
5. **Owner-added only.** Other ways in (invite links, self sign-up, agents, the paywall) come later; owner-added needs no abuse protection and works while SES is in its sandbox.
6. **Per site.** Tiers, memberships and rules belong to one site.
7. **No member limit.** Member count doesn't affect the edge, cookies or sign-in; the daily invite cap limits email, and lists come in pages.
8. **Start and end dates on every grant,** checked at sign-in, so nothing needs scheduling. Shares always end (90 days by default, a year at most) because they're ad hoc and easy to forget; memberships needn't, since they're deliberate and managed.
9. **Audit and last used:** `passa shares` lists every share across sites, with when each was last used, so forgotten shares are easy to spot; memberships show last used too.

## Early checks

- **Render audiences as sets:** list-and-link visibility with overlapping tiers, page rules inside folder rules, and shares; the leak tests from M3 R82 extended to tiers.
- **The edge budget** with realistic folder and page rules, now that rules can come from front matter.
- **Moving M5's rules and shares** on a copy of dev's data.

## Starting values

| Setting | Value |
| --- | --- |
| Rules per site | 20 (edge budget ~850 bytes) |
| Tier names | 1–30 lowercase letters, digits, hyphens; `public`, `private`, `shared` reserved |
| Grant end | memberships: optional (none: until removed); shares: 90 days by default, at most a year ahead |
| Invites | count against `rateLimits.invitesPerDay`; at most hourly per email and tier or path |
| Member list page | 100 |

## Delivery

1. Rules in the new form (`access` lists), the move from M5's form, and render's set audiences.
2. Access in `_site.yml` and front matter, as the source of truth for Markdown sites.
3. Memberships: tools, CLI, invites, revocation, dates; shares' new reach and start dates.
4. "What can this person see?", docs, and the demo on dev, then production.

## Changes after approval

Changes to the approved spec are recorded here, each with its date and reason, rather than edited in silently.

- **2026-11-07, after the early checks** (`agent-publisher/spikes/membership/`):
  - **R161, lists.** As approved, lists compared audiences only, and a brute-force check found that pages read through a share could list pages their reader can't open (11 cases in the example), worst when a private page was shared, since owner-only pages list everything. Making lists safe for share readers would have shortened them for members too (pages are built once, for everyone). The owner's call: lists are made for audiences; a share reader may see titles, never content; members come first. Pages under a `private` rule now list only their own rule's pages and public ones, which affects only the owner and keeps every private title off pages a share opens.
  - **R167, new:** links to pages that aren't public carry the target's rule ID, for a later theme or script to tidy links a viewer can't follow. Client-side hiding can't protect titles, only tidy pages.
  - **R162 and the edge.** The dry run on dev's data showed that dropping M5's `shared` rules would cut off their shares, which need a rule at their path; they become `private` rules instead. And `private` rules now go to the edge with an ID, so shares on them open.
  - **R162, no old form accepted (owner's call, during step 1).** Tools, the CLI and render take only the new form; nothing outside Passa uses the old `tier` field. Rules already stored in the old form are converted when the store reads them, and rewritten in the new form the next time they change.
  - **R150, how a site's files take over its access (during step 2).** A site opts in by declaring `access` in its `_site.yml`; without it, its stored rules apply and front matter `access` stays M3's hint (R89), so existing sites such as the docs, whose pages say `access: public`, don't suddenly get a rule per page. On a site whose files declare access, `set_access` (and `passa access --rule`) is refused, saying to change the files, rather than Passa rewriting `_site.yml` and risking its comments and layout; a share needing a new rule is refused the same way, saying which rule to add. A version whose files stop declaring access keeps the rules it had, and `set_access` works again.
  - **R149, the edge budget (kept, measured).** The bytes run out before 20 rules once paths are long: about 20 fit with short paths (`/lessons/week-12/`), 15 with medium (`/courses/spec-driven/module-3/`) and 10 with long nested ones, which page rules from front matter make likely. The owner's call: keep the limit with a clear refusal, and fix forward when a real site hits it (paths stored relative to the rule above, or a second KeyValueStore entry).
  - **Memberships' keys (during step 3).** One item per membership, `MEMBER#<email>#<tier>` in the site's partition, so a person's memberships are one prefix query at sign-in; a tier's members are listed through `gsi2` (`TIER#<site>#<tier>`, by email). One item instead of two keeps adding and removing to single writes.
  - **R165, shares from before M6 (during step 3).** The audit reads an index of shares by owner and end date. Shares made before M6 have no end and aren't in that index, so `passa shares` doesn't list them until they're shared again (which gives them an end); `list_access` still shows them per site. Any that matter are found per site and re-shared or removed.
  - **R166, last used (during step 3).** Marked when `auth.` hands a signed-in person a site cookie (signing in, and each hourly refresh) for every live grant that opens a rule, as the day (`2026-11-07`), at most once a day per grant.

## Done when

- The demo works.
- Tested: rules listing several tiers; `private` closing a path inside a tier folder and a public one; `public` combined with tiers refused; a page's front matter overriding its folder; public access from files needing confirmation; members opening their tiers' paths and nothing else; a share reaching a path whatever its rule, and stopping at a sub-rule (named in the result); start and end dates on memberships and shares (a share's default end, and its one-year limit); `passa shares` across sites and last used on shares and memberships; removing a membership and a share; render lists without leaks across tiers; `--as` showing what a person opens and why; M5's rules and shares moved; the CLI matching every tool.
