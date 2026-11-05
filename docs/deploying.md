---
title: Deploying Passa
description: Run Passa in your own AWS account with CDK.
access: public
---

# Deploying Passa

Passa is self-hosted: it runs in your own AWS account, and there's no hosted service. One deployment serves you, or your organisation: admins add the people who can publish.

## What it uses

| Part | AWS |
| --- | --- |
| Sites | S3 behind CloudFront, with access checked at the edge by a CloudFront Function |
| Sign-in and OAuth (`auth.`) | Lambda behind CloudFront, with WAF |
| MCP server (`mcp.`) | Lambda behind API Gateway, with throttling |
| Data | DynamoDB |
| Email | SES, or any SMTP service, for sign-in links and invites (see [[Email]]) |
| Malware scanning | GuardDuty, for uploads |

It's all defined with CDK, in stacks named `passa-<stage>-<part>` and tagged `project=passa`, so the account can be shared with other projects. A dev stage and a production stage can live in separate accounts (recommended) or one.

## Domains

Passa needs two names:

- **`domain`**, Passa's own: `auth.` and `mcp.` live under it, and magic links come from it. Use a domain or subdomain that hosts nothing else.
- **`siteDomain`**, where sites are served as `<site>.<siteDomain>`. A separate registrable domain is safest: published sites run whatever scripts were written for them, and a separate domain keeps them apart from sign-in. Changing it later changes every site's link.

## Steps

You need Node.js 24, pnpm and the AWS CLI, signed in to your accounts.

1. **Configure.** Clone the [repository](https://github.com/rheinardkorf/passa), copy `config.example.yml` to `config.yml`, and set `domain`, `siteDomain`, `accounts`, `region`, `admins` and `email.from`. Under `stages.dev`, give dev its own domains, so it never touches production's.

2. **Bootstrap CDK** once per account, in your region and in `us-east-1`, where CloudFront's certificates and WAF live:

   ```sh
   cd packages/infra
   pnpm cdk bootstrap aws://<account>/<region> aws://<account>/us-east-1 -c stage=prod
   ```

3. **Deploy the foundation** first. It creates the hosted zones and the email identity, and prints the name servers:

   ```sh
   pnpm cdk deploy passa-prod-foundation -c stage=prod
   ```

   Set those name servers at your registrar, or add NS records for them in the parent zone.

4. **Ask AWS for SES production access** in that account and region. Until it's granted, SES only sends to addresses you've verified, which is enough to get going: verify your own. Or send through an SMTP service instead: see [[Email]].

5. **Deploy everything:**

   ```sh
   pnpm cdk deploy --all -c stage=prod
   ```

   Each admin gets an email to confirm alarm notifications.

6. **Connect an agent** to `https://mcp.<domain>/mcp`, and sign in with an admin email. See [[Get started]]. To let others publish, see [[Publishers and admins]].

## Cost

Passa is built from services that cost nothing when idle and little at personal scale: no servers, containers or databases run all the time. Set an AWS budget alert all the same.
