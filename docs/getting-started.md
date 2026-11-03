---
title: Get started
description: Connect an agent to a Passa deployment, publish a site, and share it.
access: public
---

# Get started

You need a Passa deployment: your own, or one someone has added you to as a publisher. Its MCP server is at `mcp.` on its domain, such as `https://mcp.example.com/mcp`. To run your own, see [[Deploying Passa]].

## Connect an agent

Any agent that supports remote MCP servers with OAuth can connect. In Claude Code:

```sh
claude mcp add --transport http passa https://mcp.example.com/mcp
```

Then run `/mcp`, choose `passa` and authenticate. Your browser opens Passa's sign-in page: enter your email, open the magic link Passa sends, and allow access. In Claude Desktop or claude.ai, add it as a custom connector with the same URL.

Only publishers can connect, and the consent page shows which app is asking, so check it's the one you expect.

## Publish something

Ask your agent:

> Write a one-page summary of this week's work and publish it with Passa.

The agent calls the `publish` tool and gets back a link like `https://k3x9q2.example.com/`. The site is private: open it and sign in with your email to see it.

To change it, ask the agent again. Every change makes a new version at the same link, and earlier versions can be restored.

## Share it

Private sites can only be opened by you. To share a site, make it public:

> Make that site public.

Before anything goes public, the agent has to check with you: Passa refuses the change until the agent confirms you agreed. You can also make only some folders public; see [[Access]].

A public site can have a name, which becomes its address:

> Call it weekly-notes.

The site is then at `weekly-notes.example.com`, and its old address redirects there.

## Without an agent

The `passa` command does all of this from a terminal:

```sh
npm install -g @passajs/cli
passa login mcp.example.com
passa publish my-folder --title "Weekly notes"
passa access my-folder --public
```

See [[The passa CLI]].

## Next

- Write sites in Markdown, with themes, widgets and charts: [[Markdown sites]].
- Control who sees what: [[Access]].
