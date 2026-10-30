# Passa

Publish what your AI agents make to a private link on your own domain.

Say "publish this" to any MCP-capable agent and get back a link like `https://k3x9q2.example.com`. Sites are private by default, and viewers sign in with a magic link. Passa runs in your own AWS account.

**Status:** early development. The first iteration, private sites, works end to end on AWS and is being finished; it's described in [`spec/iterations/`](spec/iterations/). Expect breaking changes.

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
pnpm local proxy                        # sites, sign-in and MCP on port 8080
pnpm local publish examples/hello       # in another terminal: prints the site URL
```

Open the site URL and sign in with the first admin email from your config. Moto doesn't deliver email, so the proxy prints the magic link in its terminal. Use a browser that treats `*.localhost` as secure, such as Chrome or Firefox, since Passa's cookies are `Secure`.

To publish from Claude Code against your local Passa:

```sh
claude mcp add --transport http passa-local http://mcp.localhost:8080/mcp
```

In a new Claude Code session, run `/mcp`, choose `passa-local` and authenticate: sign in with the admin email (the link is printed by the proxy) and allow access. Then ask Claude to publish something. Connected apps are listed at http://localhost:8080/apps.

The integration tests (`pnpm test:int`) need Moto running and Google Chrome installed; set `PASSA_TEST_CHROME` to use another Chromium-based browser.

## Deploying

Passa deploys with CDK into your own AWS account: one stage for dev and one for production. They can be separate accounts (recommended) or the same one. Every stack is named `passa-<stage>-<part>` and tagged `project=passa`, so the accounts can be shared with other projects.

1. **Config.** Copy `config.example.yml` to `config.yml` and set:
   - `domain`, Passa's own domain: `auth.` and `mcp.` live under it, and magic links come from it. Use a domain or subdomain that hosts nothing else.
   - `siteDomain`, where sites are served as `<site-id>.<siteDomain>`. A separate registrable domain is safest; see [`SECURITY.md`](SECURITY.md).
   - `accounts`, `region`, `admins` and `email.from` (an address at `domain`).
   - Under `stages.dev`, dev's own `domain`, `siteDomain` and `email`, so dev never touches production's names.

2. **Bootstrap CDK** once per account, in your region and in `us-east-1` (CloudFront's certificates and WAF live there):

   ```sh
   cd packages/infra
   pnpm cdk bootstrap aws://<account>/<region> aws://<account>/us-east-1 -c stage=prod
   ```

3. **Deploy the foundation first.** It creates the hosted zones and the SES identity, and prints their name servers:

   ```sh
   pnpm cdk deploy passa-prod-foundation -c stage=prod
   ```

   Set those name servers at your registrar, or add NS records for them in the parent zone. For dev on subdomains, deploy `passa-dev-foundation` and add NS records for its zones in production's.

4. **Ask AWS for SES production access** in the production account and region. Until it's granted, SES only sends to verified addresses, which is enough for dev: verify your own address there.

5. **Deploy everything:**

   ```sh
   pnpm cdk deploy --all -c stage=prod
   ```

   Each admin gets an email to confirm the alarm subscription.

6. **Connect an agent.** In Claude Code:

   ```sh
   claude mcp add --transport http passa https://mcp.<domain>/mcp
   ```

   Then run `/mcp`, sign in with an admin email and allow access.

## License

[MIT](LICENSE)
