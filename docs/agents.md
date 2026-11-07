---
title: Agents and MCP
description: How agents connect to Passa, and the tools they use.
access: public
---

# Agents and MCP

Agents connect to Passa's MCP server at `https://mcp.example.com/mcp` over HTTP, and sign in with OAuth 2.1. There are no API keys.

## Signing in

1. The agent finds Passa's sign-in server from the MCP server's metadata, and registers itself.
2. Your browser opens the sign-in page. You enter your email and open the magic link Passa sends.
3. The consent page names the app and where it will send you back. If you allow it, the agent gets a short-lived token for the MCP server only, and a refresh token that changes each time it's used.

Connected apps are listed at `auth.` on your deployment's domain, where you can revoke any of them. Only publishers — people the deployment's admins have added — can connect.

## Tools

| Tool | What it does |
| --- | --- |
| `publish` | Publishes files as a new site, private unless rules say otherwise |
| `update` | Changes a site: new or changed files, removals, small text edits, or a whole folder with `sync` |
| `begin_upload`, `finish_upload` | Uploads larger files, or files read from disk, straight to storage |
| `get_site` | A site's details, versions and files |
| `get_files` | The contents of a site's files |
| `find_sites` | Lists your sites, optionally matching a title or name |
| `set_access` | Replaces a site's access rules |
| `share`, `unshare` | Shares a site or one folder with an email, sending an invite, or stops sharing it |
| `list_access` | A site's rules, its tiers and who it's shared with; with `email`, what one person opens and why |
| `add_member`, `remove_member`, `list_members` | Adds an email to a tier (such as `gold`), sending an invite, removes them, or lists a site's members. See [[Membership]] |
| `list_shares` | Every share across your sites, soonest end first, with when each was last used |
| `set_name` | Gives a site a name, which becomes its address |
| `rollback` | Makes an earlier version current again |
| `delete` | Deletes a site |
| `theme_guide` | The theme guide, for writing themes and widgets |

Each tool's description tells the agent what it needs to know: limits, how Markdown renders, and when to check with you.

## Checks that don't depend on the agent

The server enforces these, whatever the agent does:

- Making anything public needs `confirm_public`, which the agent should only send after you agree.
- Sharing needs `confirm_share`, and adding a member `confirm_member`, after the agent reads the email back to you; invites are limited per day, and shares per site.
- Uploads are scanned for malware before they're used.
- File types, sizes and paths are checked, and a site's limits apply (by default 1,000 files, 25 MB per file and 100 MB per site).
- Every change is recorded with who made it.

## Limits and history

A Markdown file and the page made from it count as one file. Every change makes a new version. Versions are kept for 30 days, then the last version of each month for 24 months, and the current version is always kept. A deleted site stops being served at once and is removed for good after seven days. A deployment can change these defaults.
