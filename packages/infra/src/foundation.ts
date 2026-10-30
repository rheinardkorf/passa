// The parts of a deployment that take time to settle, so they're deployed
// first: the hosted zones (their name servers are then set at the registrar,
// or delegated from a parent zone) and the SES identity that sends magic
// links, which needs DNS before SES will grant production access.
import { type Config, senderDomain, siteDomain } from '@passa/shared';
import { CfnOutput, Fn, Stack, type StackProps } from 'aws-cdk-lib';
import { type IPublicHostedZone, PublicHostedZone, TxtRecord } from 'aws-cdk-lib/aws-route53';
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';

export type FoundationProps = StackProps & { config: Config };

export class FoundationStack extends Stack {
  readonly zone: PublicHostedZone;
  // Where site records go: the main zone, unless sites are on another domain.
  readonly siteZone: IPublicHostedZone;

  constructor(scope: Construct, id: string, props: FoundationProps) {
    super(scope, id, props);
    const { domain, email } = props.config;
    const sender = senderDomain(email.from);
    if (sender !== domain) throw new Error(`email.from must be an address at ${domain}, not ${sender}`);

    this.zone = new PublicHostedZone(this, 'Zone', { zoneName: domain });
    this.nameServers('NameServers', this.zone, domain);

    const sites = siteDomain(props.config);
    if (sites === domain || sites.endsWith(`.${domain}`)) {
      this.siteZone = this.zone;
    } else {
      const siteZone = new PublicHostedZone(this, 'SiteZone', { zoneName: sites });
      this.nameServers('SiteNameServers', siteZone, sites);
      this.siteZone = siteZone;
    }

    // Easy DKIM records, and a MAIL FROM subdomain so bounces and SPF align
    // with the domain rather than amazonses.com. If its MX record ever fails,
    // SES falls back to its own MAIL FROM, and DKIM still passes DMARC.
    new EmailIdentity(this, 'Email', {
      identity: Identity.publicHostedZone(this.zone),
      mailFromDomain: `mail.${domain}`,
    });

    // Only SES sends as this domain, and always DKIM-signed, so receivers can
    // reject anything else claiming to be from it.
    new TxtRecord(this, 'Dmarc', { zone: this.zone, recordName: '_dmarc', values: ['v=DMARC1; p=reject; adkim=s; aspf=r'] });
  }

  private nameServers(id: string, zone: PublicHostedZone, name: string) {
    new CfnOutput(this, id, {
      description: `Set these as ${name}'s name servers at its registrar, or delegate to them from the parent zone`,
      value: Fn.join(' ', zone.hostedZoneNameServers ?? []),
    });
  }
}
