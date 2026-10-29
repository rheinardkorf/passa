# Security

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this
repository. Don't open a public issue.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get a reply within a week.

## Scope

Passa is self-hosted: each deployment runs in its owner's AWS account. Reports
about the Passa code and its default configuration are in scope. Problems in a
particular deployment's own configuration should go to that deployment's owner.

## Choosing a site domain

Published sites run whatever scripts the agent wrote. Each site has its own
origin and a content security policy that stops it sending data anywhere, but
on the same domain as `auth.` sites are same-site with it, so browsers'
same-site cookie protections don't apply between them. Passa doesn't rely on
those protections, but setting `siteDomain` in `config.yml` to a domain used
only for sites adds that layer. Changing it later changes every site's link.
