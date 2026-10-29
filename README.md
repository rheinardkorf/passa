# Passa

Publish what your AI agents make to a private link on your own domain.

Say "publish this" to any MCP-capable agent and get back a link like `https://k3x9q2.example.com`. Sites are private by default, and viewers sign in with a magic link. Passa runs in your own AWS account.

**Status:** early development. Nothing here is usable yet. The current iteration is described in [`spec/iterations/`](spec/iterations/).

## Development

Needs Node 24, pnpm and Docker.

```sh
pnpm install
pnpm check          # lint, typecheck, unit tests, leak and license checks
pnpm local:up       # start Moto, a local AWS emulator, on port 5005
pnpm test:int       # integration tests against Moto
pnpm local:down
```

To try a site locally (with Moto running):

```sh
pnpm local setup                        # tables, buckets, a signing key, admins from config
pnpm local proxy                        # sites at http://<site-id>.localhost:8080
pnpm local publish examples/hello       # prints the site URL and a sign-in link
pnpm local signin <site-id>             # a fresh sign-in link (valid for 60 seconds)
```

Until magic-link sign-in is built, `signin` stands in for it. Use a browser that treats `*.localhost` as secure, such as Chrome or Firefox, since the site cookie is `Secure`.

## License

[MIT](LICENSE)
