// What CloudFront needs from us-east-1: the certificates for auth.<domain>
// and the sites, and the WAF rules in front of auth. (R20, R27).
import { type Config, siteDomain } from '@passa/shared';
import { Stack, type StackProps } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import type { IHostedZone } from 'aws-cdk-lib/aws-route53';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export type GlobalProps = StackProps & { config: Config; stage: string; zone: IHostedZone; siteZone: IHostedZone };

const visibility = (metricName: string) => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName });

export class GlobalStack extends Stack {
  readonly authCertificate: Certificate;
  readonly siteCertificate: Certificate;
  readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: GlobalProps) {
    super(scope, id, props);
    const { domain, rateLimits } = props.config;
    const prefix = `passa-${props.stage}`;

    this.authCertificate = new Certificate(this, 'AuthCertificate', {
      domainName: `auth.${domain}`,
      validation: CertificateValidation.fromDns(props.zone),
    });
    // Every site is one label under the site domain, so one wildcard covers them.
    this.siteCertificate = new Certificate(this, 'SiteCertificate', {
      domainName: `*.${siteDomain(props.config)}`,
      validation: CertificateValidation.fromDns(props.siteZone),
    });

    // Sign-in and client registration are the endpoints that send email or
    // create records, so they get a much lower limit than the rest.
    const forms = {
      andStatement: {
        statements: [
          { byteMatchStatement: { fieldToMatch: { method: {} }, positionalConstraint: 'EXACTLY', searchString: 'POST', textTransformations: [{ priority: 0, type: 'NONE' }] } },
          {
            orStatement: {
              statements: ['/signin', '/reg'].map((path) => ({
                byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', searchString: path, textTransformations: [{ priority: 0, type: 'NONE' }] },
              })),
            },
          },
        ],
      },
    };
    const managed = (priority: number, name: string) => ({
      name,
      priority,
      overrideAction: { none: {} },
      statement: { managedRuleGroupStatement: { vendorName: 'AWS', name } },
      visibilityConfig: visibility(`${prefix}-${name}`),
    });

    this.webAcl = new CfnWebACL(this, 'AuthAcl', {
      name: `${prefix}-auth`,
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${prefix}-auth`),
      rules: [
        managed(0, 'AWSManagedRulesAmazonIpReputationList'),
        managed(1, 'AWSManagedRulesKnownBadInputsRuleSet'),
        {
          name: 'forms-per-ip',
          priority: 2,
          action: { block: {} },
          statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit: rateLimits.authFormsPerIp, evaluationWindowSec: 300, scopeDownStatement: forms } },
          visibilityConfig: visibility(`${prefix}-auth-forms-per-ip`),
        },
        {
          name: 'requests-per-ip',
          priority: 3,
          action: { block: {} },
          statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit: rateLimits.authPerIp, evaluationWindowSec: 300 } },
          visibilityConfig: visibility(`${prefix}-auth-requests-per-ip`),
        },
      ],
    });
  }
}
