# Roadmap

Each milestone has a spec in [`iterations/`](iterations/), written and approved before it's built. Items under "Later" have no spec yet. The order of "Next" and "Later" can change.

## Done

| Milestone | What it added |
| --- | --- |
| [M1: Private sites](iterations/m1-private-sites.md) | Publishing over MCP with OAuth, sign-in by email link, access checked at the edge, versions, malware scanning |
| [M2: Public sites](iterations/m2-public-sites.md) | Path rules, named sites, search indexing |
| [M3: Markdown](iterations/m3-markdown.md) | The renderer, themes, widgets, decks, social cards, local `passa render`, `serve` and `check` |
| [The CLI](iterations/cli.md) | `@passajs/cli`: sign in and publish from a terminal |
| [M4: Custom domains](iterations/m4-custom-domains.md) | A site at its own domain, attached by an admin |
| [M5: Sharing](iterations/m5-sharing.md) | Sharing a path with a person by email, mail providers, admin users |
| [M6: Membership](iterations/m6-membership.md) | Tiers of members, access in a site's files, start and end dates |

## In progress

| Milestone | State |
| --- | --- |
| [M7: Fragments and sign-in](iterations/m7-fragments.md) | Steps 1–3 built and in production; step 4 (the demo on dev, then production) left |

## Next

| Milestone | State |
| --- | --- |
| [M8: Forms](iterations/m8-forms.md) | Spec approved: the first site API |
| [M9: Self-hosted](iterations/m9-self-hosted.md) | Draft from an earlier roadmap, to be revised for M3–M8 before work starts |
| MFA: two-step sign-in | Draft, parked, not yet in the repo: a second factor for publishers and admins |

## Later

### Lean dependencies

Fewer third-party packages, especially in production code, where they make up most of the supply-chain risk. Not zero: a dependency stays when it's small and would be costly or risky to replace.

As of 2026-11-17, the lockfile has 391 packages, 226 of them reachable from production code. 9 of the 11 Dependabot alerts fixed in #70 came in through the MCP SDK and express, of which Passa uses very little. Likely steps, most valuable first:

1. **Drop express, serverless-express and file-type:** plain Lambda handlers (about 18 routes in `auth.`, 4 in `mcp.`) and a small table of file signatures.
2. **Replace the MCP SDK** with Passa's own stateless handler for the methods it serves (`initialize`, `tools/list`, `tools/call`, `ping`), keeping the SDK's client as a dev dependency to test against real clients. With step 1: about 226 → 151 production packages.
3. **Tests on `node:test`** instead of vitest (204 → 147 development packages), and possibly `tsc` strict plus a few checks of Passa's own instead of ESLint (→ 53).
4. **A budget, enforced in CI:** a new dependency needs a reason in its PR, and the production count may not grow without one.

Kept: `jose`, `zod`, `yaml`, `nodemailer`, `mustache`, `markdown-it`, `highlight.js`, satori and resvg, HTMX, TypeScript, esbuild, the AWS SDK and CDK. Replacing `oidc-provider` (34 packages) with an OAuth server of Passa's own is a separate decision, and probably not worth the risk. This also makes M9 easier: a plain HTTP layer runs the same on AWS and on a self-hosted server.
