import { parseConfig, siteHeaders } from '@passa/shared';
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
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
      }),
    });
  });

  it('builds the function from handler.js with the store and both domains', () => {
    const fn = Object.values(sites.findResources('AWS::CloudFront::Function'))[0];
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
        CustomHeadersConfig: { Items: Match.arrayWith([{ Header: 'cache-control', Value: 'private, no-cache', Override: true }, { Header: 'x-robots-tag', Value: 'noindex', Override: true }]) },
      }),
    });
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
