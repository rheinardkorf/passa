# passa

Build, preview and check a Markdown site on your own machine, and publish it to a [Passa](https://github.com/rheinardkorf/passa) deployment: private links for what you and your AI agents make.

> **Early days.** Passa is a personal project, and this package is published so its author can run the CLI on their own machines. It changes without notice, and publishing needs a Passa deployment of your own. You're welcome to try it, but don't depend on it yet.

```
npm install -g @passajs/cli   # installs the passa command (Node.js 24 or later)
passa init my-site            # an index.md, _site.yml and a starter theme
passa serve my-site           # preview on localhost, rebuilding on change
passa render my-site          # build it into a folder of HTML
```

Or run it without installing: `npx @passajs/cli init my-site`.

## Local commands

These need no account and no network.

| Command | What it does |
| --- | --- |
| `passa init [folder]` | Starts a site |
| `passa serve <folder>` | Previews it on localhost, served as Passa would, rebuilding on change |
| `passa render <folder> [--out dist]` | Builds it into a folder of HTML, with a social card for each public page |
| `passa check <folder>` | Reports the problems a publish would, such as broken links or bad widget data; exits 1 if there are any, for CI |
| `passa theme guide` | Prints the theme contract, for people and agents writing themes |

Nothing outside Passa protects private pages, so only public pages are built: those whose front matter says `access: public`, or, in a folder published with Passa, the ones its access rules make public. `--include-private` builds everything for a local preview.

## Publishing to a Passa deployment

Passa is open source and runs in your own AWS account; see the [repository](https://github.com/rheinardkorf/passa) to deploy one. The CLI signs in through the browser as agents do, and calls the same tools, so the server checks everything the same way.

```
passa login mcp.example.com            # sign in (tokens in ~/.config/passa, readable only by you)
passa publish my-site --title "Notes"  # a new private site; the folder remembers it
passa access my-site --public          # asks before anything goes public
passa sync my-site                     # only changed files go up, with the social cards drawn locally
passa pull <site> other-folder         # a site's sources, on another machine
passa sites                            # also: site, name, rollback, delete, logout, whoami
```

Signed in to more than one deployment? Switch with `passa use <server>`, pass `--server <server>` to one command, or set `PASSA_SERVER` for a shell. A linked folder always uses the server it came from.

Run `passa --help` for every command and option.

## License

MIT
