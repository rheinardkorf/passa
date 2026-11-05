---
title: Email
description: "How Passa sends sign-in links and invites: through Amazon SES, or any SMTP service."
access: public
---

# Email

Passa sends two kinds of email: sign-in links, and invites when a site is shared. Both come from `email.from` in `config.yml`, and both say the same whichever provider sends them. Neither ever includes a site's title, and tracking is off.

Mail is sent in the background, so sign-in and sharing answer just as quickly whether or not an email goes out, and however slow the provider is.

Choose the provider with `email.provider`: `ses` (the default) or `smtp`.

## Amazon SES

```yaml
email:
  from: Passa <no-reply@example.com>
```

The foundation stack verifies `domain` in SES. The sender must be at that domain.

A new AWS account's SES is in its **sandbox**: it only sends to addresses you've verified. That's enough to start, by verifying your own address and those of the people you share with, but ask AWS for production access to send to anyone.

SES reports bounces and complaints to Passa, which disables a publisher whose address bounces (never an admin) and tells the admins.

## SMTP

Almost any mail service has SMTP, so this is the way to send through one when SES isn't an option.

```yaml
email:
  from: Passa <passa@example.com>
  provider: smtp
  smtp:
    host: smtp.example.com
    port: 465 # TLS; or 587, with STARTTLS required
    user: passa@example.com
    passwordParameter: /passa/prod/smtp-password
```

The password never goes in `config.yml`. Store it in Parameter Store as a `SecureString`, in the deployment's account and region, under the name `passwordParameter` gives:

```sh
aws ssm put-parameter --type SecureString --name /passa/prod/smtp-password --value '<password>'
```

Only the mail function can read it. Passa only connects over TLS: port 465, or 587 with STARTTLS, never in plain text.

With SMTP, the service handles bounces itself, usually by no longer sending to an address that bounced: check its suppression list if someone says they get nothing.

### Examples

| Service | Host | Port | User | Password |
| --- | --- | --- | --- | --- |
| Gmail or Google Workspace | `smtp.gmail.com` | 465 | Your address | An app password |
| Postmark | `smtp.postmarkapp.com` | 587 | A server API token | The same token |
| Resend | `smtp.resend.com` | 465 | `resend` | An API key |

Some services only send from the account's own address, or addresses verified with them. **Gmail** replaces any other `From` with your own address, so set `email.from` to it (or to an alias the account can send as). Services like Postmark and Resend send from a domain you've verified with them.

## Switching

Change `email.provider` (and `email.smtp`), then deploy the services stack. Nothing else changes: the next email goes through the new provider.
