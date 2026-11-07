---
title: Domains in Route 53
description: "Custom domains whose DNS is in Route 53, where Passa can write the records itself."
access: public
---

# Domains in Route 53

If the domain's hosted zone is in Route 53, in **the same AWS account as the Passa deployment**, Passa can write the records itself and remove them again when the domain goes. You set that up once per zone; after that, adding a domain is one command.

If the zone is in a different AWS account, Passa can't reach it: follow [[Domains at other DNS hosts]] and add the records in that account's Route 53 console instead (the steps are the same, with an alias record for an apex).

## Once per zone: let Passa write to it

1. **Find the zone's ID**, in the deployment's account:

   ```sh
   aws route53 list-hosted-zones-by-name --dns-name example.com \
     --query 'HostedZones[0].Id' --output text
   ```

   It prints something like `/hostedzone/Z0123456789ABCDEFGHIJ`. The ID is the part after the last slash.

2. **List it in `config.yml`**, under the stage that should use it. Each stage is usually its own AWS account with its own zones:

   ```yaml
   stages:
     prod:
       domains:
         zones: [Z0123456789ABCDEFGHIJ]
     dev:
       domains:
         zones: [Z9876543210ZYXWVUTSRQ]
   ```

   Zones not listed are never touched: the admin function is only allowed to change these.

3. **Deploy the sites stack**, which gives the admin function permission for exactly those zones:

   ```sh
   cd packages/infra
   pnpm cdk deploy passa-prod-sites -c stage=prod
   ```

   CDK asks you to confirm, since the change touches permissions. In a script, add `--require-approval never` once you've read the change.

## Add the domain

```sh
AWS_PROFILE=prod AWS_REGION=ap-southeast-2 \
  passa admin domain add docs.example.com my-docs --new-tenant
```

```
Adding docs.example.com to my-docs (a tenant of its own).
  DNS records, written in Route 53:
    CNAME docs.example.com  →  d1abc2def3.cloudfront.net
  Waiting for DNS: 1 record not resolving yet…
  DNS records, written in Route 53:
    CNAME _3f1c….docs.example.com  →  _9a8b….acm-validations.aws
  Waiting for the certificate…
  Attaching the domain to CloudFront…
  Waiting for CloudFront to deploy it…
Live: https://docs.example.com/ is now my-docs's address; its other addresses redirect there.
```

There's nothing to add by hand. For the zone's own name (an apex, such as `example.com`), Passa writes an alias A record instead of a CNAME.

## Remove it

```sh
passa admin domain remove docs.example.com
```

The site moves to its next address first, then the domain is detached, and Passa deletes the records it wrote. Records you added yourself are left alone.
