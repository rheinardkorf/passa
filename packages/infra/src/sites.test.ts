import { siteHeaders } from '@passa/shared';
import { parseConfig } from '@passa/shared/config-file';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { responseHeadersPolicy } from './sites.ts';
import { addStage } from './stacks.ts';
import { exampleConfig, testApp } from './testing.ts';

const config = parseConfig({ ...exampleConfig(), siteDomain: 'example-sites.com' });
const stacks = addStage(testApp(), config, 'prod');
const sites = Template.fromStack(stacks.sites);

describe('sites stack', () => {
  it('serves every site under the wildcard from the bucket, through the edge handler', () => {
    sites.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['*.example-sites.com'],
        DefaultCacheBehavior: Match.objectLike({
          AllowedMethods: ['GET', 'HEAD'],
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' }), Match.objectLike({ EventType: 'viewer-response' })],
        }),
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
      }),
    });
  });

  it('serves custom domains from a multi-tenant distribution with the same behaviour (M4 R121)', () => {
    const distributions = Object.values(sites.findResources('AWS::CloudFront::Distribution'));
    const tenantOnly = distributions.find((d) => d.Properties.DistributionConfig.ConnectionMode === 'tenant-only');
    const main = distributions.find((d) => d.Properties.DistributionConfig.Aliases);
    expect(tenantOnly).toBeDefined();
    const config = tenantOnly?.Properties.DistributionConfig;
    expect([config.Aliases, config.IPV6Enabled, config.PriceClass]).toEqual([undefined, undefined, undefined]);
    expect(config.ViewerCertificate).toEqual({ CloudFrontDefaultCertificate: true, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' });
    // The same origin, functions, headers and error pages as the main one.
    const behaviour = (d: typeof config) => ({ ...d.DefaultCacheBehavior, TargetOriginId: undefined });
    expect(behaviour(config)).toEqual(behaviour(main?.Properties.DistributionConfig));
    expect(config.Origins[0].DomainName).toEqual(main?.Properties.DistributionConfig.Origins[0].DomainName);
    expect(config.CustomErrorResponses).toEqual(main?.Properties.DistributionConfig.CustomErrorResponses);
    sites.hasResourceProperties('AWS::CloudFront::ConnectionGroup', { Name: 'passa-prod-domains', Ipv6Enabled: true });
  });

  it('gives the admin function only what attaching domains needs (M4 security)', () => {
    const fn = Object.entries(sites.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith('AdminFunction'));
    expect(fn?.[1].Properties.FunctionName).toBe('passa-prod-admin');
    expect(fn?.[1].Properties.Environment.Variables).toMatchObject({ PASSA_DOMAINS_DISTRIBUTION: expect.anything(), PASSA_DOMAINS_CONNECTION_GROUP: expect.anything() });
    const policy = JSON.stringify(Object.values(sites.findResources('AWS::IAM::Policy')).filter((p) => JSON.stringify(p).includes('AdminFunction')));
    // Certificates only when tagged for Passa; no Route 53 unless config lists zones.
    expect(policy).toContain('"aws:RequestTag/project":"passa"');
    expect(policy).toContain('"aws:ResourceTag/project":"passa"');
    expect(policy).not.toContain('route53:');
    expect(policy).not.toMatch(/"cloudfront:\*"|"acm:\*"/);
    // Nothing can invoke it but IAM principals allowed to: no URL, no API.
    expect(Object.keys(sites.findResources('AWS::Lambda::Url'))).toEqual([]);
  });

  it('lets the admin function change only the Route 53 zones config lists', () => {
    const zoned = addStage(testApp(), parseConfig({ ...exampleConfig(), domains: { zones: ['Z0123456789ABC'] } }), 'prod');
    const policy = JSON.stringify(Template.fromStack(zoned.sites).findResources('AWS::IAM::Policy'));
    expect(policy).toContain('hostedzone/Z0123456789ABC');
    expect(policy).toContain('route53:ChangeResourceRecordSets');
  });

  it('builds the function from handler.js with the store and both domains', () => {
    const fn = Object.values(sites.findResources('AWS::CloudFront::Function')).find((f) => JSON.stringify(f).includes('cf.kvs'));
    // Fn::Join of the code around the store's ID.
    const code = (fn?.Properties.FunctionCode['Fn::Join'][1] as unknown[]).filter((part) => typeof part === 'string').join('<id>');
    expect(code).toContain("cf.kvs('<id>')");
    expect(code).toContain('"example-sites.com"');
    expect(code).toContain('"https://auth.example.com"');
    expect(code).not.toContain('passa-kvs-placeholder');
    expect(fn?.Properties.FunctionConfig.KeyValueStoreAssociations).toHaveLength(1);
  });

  it('sends the same headers as the local proxy', () => {
    const headers = siteHeaders(config);
    sites.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({ ContentSecurityPolicy: { ContentSecurityPolicy: headers['content-security-policy'], Override: true } }),
        CustomHeadersConfig: { Items: Match.arrayWith([
          { Header: 'cache-control', Value: 'private, no-cache', Override: true },
          // Relaxed for public files by the viewer-response function, so not overridden.
          { Header: 'cross-origin-resource-policy', Value: 'same-origin', Override: false },
        ]) },
      }),
    });
  });

  it('decides x-robots-tag by host in a viewer-response function, not in the headers policy', () => {
    const policy = JSON.stringify(sites.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
    expect(policy).not.toContain('x-robots-tag');
    sites.hasResourceProperties('AWS::CloudFront::Function', { FunctionCode: Match.stringLikeRegexp('function viewerResponse\\(event, options\\)') });
  });

  it('refuses site headers it cannot express exactly', () => {
    expect(() => responseHeadersPolicy({ ...siteHeaders(config), 'referrer-policy': 'origin' })).toThrow(/site headers changed/);
  });

  it('turns storage misses into a plain 404', () => {
    sites.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CustomErrorResponses: [403, 404].map((code) => Match.objectLike({ ErrorCode: code, ResponseCode: 404, ResponsePagePath: '/_passa/not-found.txt' })),
      }),
    });
  });

  it('puts sites on their own zone when the site domain is another domain', () => {
    Template.fromStack(stacks.foundation).resourcePropertiesCountIs('AWS::Route53::HostedZone', { Name: 'example-sites.com.' }, 1);
    sites.hasResourceProperties('AWS::Route53::RecordSet', { Name: '*.example-sites.com.', Type: 'A' });
  });
});
