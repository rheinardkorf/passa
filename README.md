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
pnpm local proxy                        # sites and sign-in on http://*.localhost:8080
pnpm local publish examples/hello       # in another terminal: prints the site URL
```

Open the site URL and sign in with the first admin email from your config. Moto doesn't deliver email, so the proxy prints the magic link in its terminal. Use a browser that treats `*.localhost` as secure, such as Chrome or Firefox, since Passa's cookies are `Secure`.

## License

[MIT](LICENSE)
