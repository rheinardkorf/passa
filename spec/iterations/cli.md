# The Passa CLI: publishing without an agent

| | |
| --- | --- |
| **Status** | Draft |
| **Owner** | Rheinard Korf (product and technical decisions) |
| **Spec depth** | Medium: a new client of the existing MCP server and OAuth, with no new server features except where noted |
| **Security-relevant** | Yes: stores long-lived credentials on the publisher's machine, and can make things public |

## Summary

Everything an agent can do with Passa, a person can do from a terminal. `passa login` signs in through the browser, as an agent does; then `passa publish`, `passa sync`, `passa pull`, `passa access` and the rest call the same MCP tools agents call. The CLI is a thin client: the server checks everything exactly as it does for agents, so the security model doesn't change.

The local commands from M3 (`render`, `serve`, `check`, `init`, `theme guide`) stay as they are, with no account. Together they make the workflow Passa was missing: build and preview a Markdown site locally, draw its social cards with your own compute, and publish it in one command.

## Demo

`passa login`, approve in the browser. `passa init blog`, write a post, `passa serve blog` to preview, then `passa publish blog --title "My blog"`: a private site and its URL. `passa access blog --public`, confirm, and it's public. Edit a post and `passa sync blog`: only the changed files go up, with the cards `passa render` drew, so Passa draws none. On another machine, `passa pull <site> blog`, edit, `passa sync blog`. `passa rollback blog` undoes the last sync.

## Scope

**In:**

- `passa login`, `logout`, `whoami`: OAuth in the browser, with tokens stored locally.
- Commands mirroring the MCP tools: `sites`, `site`, `pull`, `publish`, `sync`, `access`, `name`, `rollback`, `delete`.
- A folder remembers its site (`.passa/site.yml`), so later commands need only the folder.
- `publish` and `sync` send the cards `passa render` draws.
- More than one deployment (such as dev and production), each signed in separately.

**Out (later):**

- Signing in without a browser on the same machine (the OAuth device flow), for SSH sessions and CI.
- CI deploy tokens and GitHub OIDC.
- Admin commands over AWS credentials (`passa admin users …`).
- Installing from npm or as a single binary; for now it runs from the repo (`pnpm passa`).

## Requirements

### Signing in

- **R99** `passa login [server]` signs in to a deployment's MCP server (default: the last one used; the first time, it asks). It registers itself as an OAuth client (dynamic registration, once per server), opens the browser to `auth.` with PKCE and a loopback redirect on `127.0.0.1` and a random port, and waits for the redirect. The person signs in by magic link and approves the CLI on the consent page, which names it, as for any client. If the browser can't be opened, the CLI prints the URL to open.
- **R100** The CLI asks only for the publishing scope and the MCP resource, as agents do, and gets the same short-lived access token and rotating refresh token. It refreshes the access token when it expires; when the refresh token is gone or revoked, commands say to run `passa login` again.
- **R101** Tokens are stored in the user's config folder (`~/.config/passa/credentials.json`, or `$XDG_CONFIG_HOME`), readable only by the user (mode 0600, in a 0700 folder); the CLI refuses to use the file if anyone else can read it. Tokens are never printed, logged or put in a URL.
- **R102** `passa logout [server]` revokes the refresh token at the server (RFC 7009) and deletes it locally. `passa whoami` shows the server and that the sign-in works, by calling a read-only tool. The CLI is listed with other connected apps at `auth.`'s apps page, where it can be revoked too.

### Sites and folders

- **R103** A folder linked to a site has `.passa/site.yml` with the server and site ID. `publish` and `pull` write it; `sync`, `access`, `name`, `rollback`, `delete` and `site` read it when given a folder, or take a site ID or name. Dotfiles aren't published, so it never reaches the site.
- **R104** `passa sites [query]` lists your sites (`find_sites`). `passa site <site|folder>` shows a site's details, access, versions and files (`get_site`).
- **R105** `passa pull <site> [folder]` writes a site's current version to a folder: its sources and plain files, and `_passa/access.yml`, not rendered pages (those are rebuilt from sources). It refuses to write into a folder with files unless it's linked to the same site, so nothing is overwritten by surprise.
- **R106** `passa publish <folder> --title <title>` publishes a folder as a new private site and links the folder to it. Files go inline when small, and through `begin_upload` otherwise; the CLI doesn't decide what's allowed, the server does, and its refusals are shown as they are.
- **R107** `passa sync <folder>` makes the linked site exactly the folder (`begin_upload` with hashes, then `update` with `sync: true`): only new and changed files are uploaded, and files the folder doesn't have are removed, after listing them and asking (`--yes` skips the question). `--base` refuses the sync if the site changed since the folder was last synced or pulled.
- **R108** `publish` and `sync` build the folder's cards first, when it has Markdown and isn't private, by running the local render and sending the `_card-<hash>.png` files with the site; the server keeps the ones its pages name, and draws the rest. `--no-cards` skips this.
- **R109** `passa access <site|folder>` shows the rules; `--public`, `--private`, or `--rule <path>=<tier>` (repeatable) replaces them (`set_access`). Anything it would make public is listed and needs typing `yes`, or `--confirm-public`, the CLI's form of `confirm_public`. `passa name <site|folder> <name|--none>` sets the name (`set_name`).
- **R110** `passa rollback <site|folder> [version]` restores a version (the previous one by default), and `passa delete <site|folder>` deletes a site after typing its ID or name (`--now` deletes immediately, `--yes` skips typing in scripts).
- **R111** Every command prints what it did in plain words, with the site's URL, and `--json` prints the tool's result as it is, for scripts. Problems the server reports (render problems, skipped files, cards waiting) are shown as warnings; refusals exit with status 1.

## Security and quality requirements

- **No new authority:** the CLI calls the same tools with the same token checks as agents; nothing on the server trusts it more. Its OAuth client is an ordinary public client, registered dynamically.
- **Credentials:** stored readable only by the user, never printed; logout revokes at the server; the redirect listener binds `127.0.0.1` only, accepts one request with the expected `state`, and closes.
- **Confirmation before anything goes public**, as for agents, and before removing files or deleting a site.
- **Small dependency footprint:** a small MCP client of the CLI's own (JSON-RPC over HTTP, about a hundred lines) rather than the MCP SDK, which brings Express and dozens of packages to a tool that only needs to call tools.

## Design

```
passa login ─► POST /reg (once) ─► browser: auth./auth?…&code_challenge ─► magic link ─► consent
           ◄── http://127.0.0.1:<port>/callback?code&state ◄──────────────────────────────┘
           ─► POST /token (code + verifier, resource=mcp.) ─► access + refresh tokens (0600 file)

passa sync blog ─► local render (cards) ─► tools/call begin_upload {site_id, files+hashes}
               ─► PUT changed files to presigned URLs ─► finish_upload ─► update {upload_id, sync}
```

- **Packages:** `packages/cli` gains `auth.ts` (login, refresh, storage), `mcp.ts` (the client: `initialize`, `tools/call`, JSON or event-stream responses, the bearer token, one refresh-and-retry on 401), and a command per tool.
- **Discovery:** the server URL is the MCP endpoint (`https://mcp.<domain>/mcp`); the CLI reads its protected-resource metadata, then the authorization server's metadata, as MCP clients do, so it needs no other configuration.

## Decisions

1. **Loopback sign-in now, device flow later.** The auth server already supports dynamic registration, PKCE and loopback redirects (Claude Code uses them), so desktop sign-in needs no server change. The device flow (for SSH and CI) needs a code-entry page on `auth.`; CI is better served by deploy tokens anyway.
2. **A token file, not the OS keychain.** Keychains need native modules or a different tool per OS. A 0600 file is what `gh` and others fall back to; the access token lasts an hour and the refresh token can be revoked from the apps page.
3. **Its own small MCP client.** Calling tools is a few JSON-RPC requests; the SDK's server-side dependencies aren't worth it in a CLI that is meant to stay light.
4. **The folder remembers its site** in a dotfile, which publishing already skips, rather than a global map of folders to sites.
5. **Cards are drawn locally by default** when publishing a public Markdown site, because that's the point of the CLI: your compute, and a publish that finishes without the server drawing anything.

## Delivery

1. `mcp.ts` and `auth.ts`: discovery, registration, login, refresh, logout, token storage. Tested against the local stack (Moto, `pnpm local proxy`), where the magic link prints to the terminal.
2. Read commands: `whoami`, `sites`, `site`, `pull`.
3. Write commands: `publish`, `sync` (with cards), `access`, `name`, `rollback`, `delete`.
4. On dev from a real terminal, then production.

## Done when

- The demo works against production from a terminal, with no agent involved.
- Tested locally and on dev: login and refresh, a revoked token (re-login asked), a token file others can read (refused), publish inline and by upload, sync with changes and removals (asked), sync refused when the site moved on, pull into a non-empty folder (refused), access to public (confirmation needed), rollback, delete (typed confirmation), cards drawn locally and stored by the server, and `--json` output.
