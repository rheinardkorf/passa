---
title: Publishers and admins
description: Who can publish to a deployment, and how admins add, list, disable and enable them.
access: public
---

# Publishers and admins

A Passa deployment has three kinds of people:

| | Can |
| --- | --- |
| **Admins** | Publish; their accounts are never disabled automatically |
| **Publishers** | Publish sites, and share them |
| **Viewers** | Open sites shared with them; nothing else. Passa adds them itself, the first time they sign in to a shared site |

Only admins and publishers can connect an agent or sign in with the `passa` command.

## Admins

The emails listed under `admins` in `config.yml` are admins. They get accounts when the deployment starts, stay admins as long as they're listed, and get the deployment's alarms by email.

Running the deployment (custom domains, and who can publish) takes its AWS credentials, not a Passa account: admin commands invoke the deployment's admin function with them, never through a Passa sign-in. Anyone with those credentials can run them, and the admin role in Passa doesn't grant them.

## Managing users

```sh
passa admin users list
passa admin users add sam@example.com
passa admin users add alex@example.com --admin
passa admin users disable sam@example.com
passa admin users enable sam@example.com
```

- **`add`** lets an email publish. With `--admin`, they're an admin too: a bounced email never disables them, and they count towards the last active admin. Someone a site was already shared with keeps their account, and their shares.
- **`disable`** stops someone: their next call through an agent or the CLI is refused, and they can't sign in. Their sites stay as they are, and public pages keep serving. Admins listed in `config.yml` can't be disabled (take them out of the list and deploy first), and neither can the last active admin.
- **`enable`** lets them back in.
- **`list`** shows everyone: admins, publishers and viewers, and whether they're active.

Each change is recorded, with the computer it was made from. The first time, `passa admin` asks which AWS profile reaches the deployment you're signed in to (or takes `--profile`), finds the deployment's admin function in that account, and remembers both. After that, admin commands need nothing extra. When the AWS sign-in has expired, it says how to sign in again with that profile. `--server` picks another deployment, `--stage` names its admin function directly, and `--json` is for scripts.
