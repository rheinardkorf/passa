---
title: The passa CLI
description: Build and preview Markdown sites locally, and publish to a Passa deployment without an agent.
access: public
---

# The passa CLI

The `passa` command builds and previews sites on your own machine with the same renderer Passa publishes with, and publishes to a Passa deployment with no agent involved.

```sh
npm install -g @passajs/cli
```

It needs Node.js 24 or later. Without installing, use `npx @passajs/cli <command>`.

## Local commands

These need no account and no network.

| Command | What it does |
| --- | --- |
| `passa init [folder]` | Starts a site: `_site.yml`, `index.md` and a first post |
| `passa serve <folder>` | Previews it on localhost, served as Passa would, rebuilding on change |
| `passa render <folder> [--out dist]` | Builds it into a folder of HTML, with a social card for each page |
| `passa check <folder>` | Reports the problems a publish would; exits 1 if there are any |
| `passa theme guide` | Prints the theme guide |

Nothing outside Passa protects private pages, so these commands only build public pages: those whose front matter says `access: public`, or, in a folder published with Passa, the ones its rules in `_passa/access.yml` make public. `--include-private` builds everything, for a preview that stays on your machine.

Options for `render`, `serve` and `check`:

| Option | |
| --- | --- |
| `--site-url <url>` | The site's address, for absolute links (default: `url` in `_site.yml`) |
| `--include-private` | Build every page, not only public ones |
| `--confirm-public` | Build even if a page marked `access: private` would be public |

## Signing in

```sh
passa login mcp.example.com
```

Your browser opens Passa's sign-in page, as it would for an agent: sign in with your email and allow the CLI. Tokens are kept in `~/.config/passa/credentials.json`, readable only by you.

| Command | What it does |
| --- | --- |
| `passa login [server]` | Signs in through the browser |
| `passa logout [server]` | Signs out, revoking the CLI's access at the server |
| `passa whoami` | Shows which deployment you're signed in to |
| `passa use [server]` | Switches to a deployment you've signed in to; with no server, lists them |

There's no default server: you always name the deployment you sign in to.

## Working with sites

| Command | What it does |
| --- | --- |
| `passa sites [query]` | Lists your sites |
| `passa site <site>` | A site's details, access, versions and files |
| `passa publish <folder> --title <title>` | Publishes a folder as a new private site, and links the folder to it |
| `passa sync [folder]` | Makes the folder's site exactly the folder; asks before removing files |
| `passa pull <site> [folder]` | Writes a site's sources into a folder, linked to the site |
| `passa access <site>` | Shows who can open what, and who it's shared with; change it with `--public`, `--shared`, `--private` or `--rule /docs/=public` |
| `passa share <site> <email>` | Shares the site, or with `--path /proposals/acme/` one folder, with an email, and sends them an invite; `--expires 2026-12-31` ends it then. See [[Sharing]] |
| `passa unshare <site> <email>` | Stops sharing with an email, from their next request; `--path` for one folder |
| `passa name <site> <name>` | Gives a site a name; `--none` removes it |
| `passa rollback <site> [version]` | Restores a version; by default, the one before the current one |
| `passa delete <site> [--now]` | Deletes a site, after a grace period or at once |

`<site>` is a site ID, a site's name, or a folder linked to a site. A linked folder has a `.passa/site.yml` file naming its server and site; dotfiles are never published.

`sync` only uploads files that changed, and draws the social cards for the site's public pages first, so Passa needn't. `--base` refuses the sync if the site has changed since the folder was last synced or pulled; `--no-cards` skips drawing cards.

Anything that would make something public asks first, as do sharing, removing files and deleting. In scripts, `--confirm-public` and `--yes` answer for you. `--json` prints the server's reply as it is.

## More than one deployment

Commands use, in order:

1. the server given with `--server`
2. a linked folder's own server
3. the `PASSA_SERVER` environment variable
4. the current server: the last one you signed in to, or chose with `passa use`

So a folder published to one deployment always syncs back to it, whatever else is set.

## Admin commands

Admins of a deployment use its AWS credentials rather than a Passa sign-in. The first time, `passa admin` asks which AWS profile reaches the deployment you're signed in to (or takes `--profile`), finds the deployment's admin function in that account, and remembers both. After that, admin commands need nothing extra. When the AWS sign-in has expired, it says how to sign in again with that profile. `--profile` chooses the profile again, `--server` picks another deployment, and `--stage` names its admin function directly (for when the CLI can't find it: finding it needs permission to list the account's Lambda functions):

- `passa admin domain add | list | status | remove` manage custom domains. See [[Custom domains]].
- `passa admin users add | list | disable | enable` manage who can publish. See [[Publishers and admins]].
