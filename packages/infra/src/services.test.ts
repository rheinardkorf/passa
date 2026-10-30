import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { addStage } from './stacks.ts';
import { exampleConfig, testApp } from './testing.ts';

const config = exampleConfig();
const stacks = addStage(testApp(), config, 'prod');
const services = Template.fromStack(stacks.services);
const global = Template.fromStack(stacks.global);

describe('global stack', () => {
  it('is in us-east-1, where CloudFront takes certificates and WAF', () => {
    expect(stacks.global.region).toBe('us-east-1');
    global.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'auth.example.com' });
  });

  it('rate-limits auth. per IP, with a lower limit for sign-in and registration', () => {
    global.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'forms-per-ip', Action: { Block: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: config.rateLimits.authFormsPerIp }) } }),
        Match.objectLike({ Name: 'requests-per-ip', Action: { Block: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: config.rateLimits.authPerIp }) } }),
      ]),
    });
  });
});

describe('services stack', () => {
  it('serves auth. through CloudFront with WAF and the secret origin header from Secrets Manager', () => {
    services.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['auth.example.com'],
        WebACLId: Match.anyValue(),
        Origins: [Match.objectLike({
          OriginCustomHeaders: [{ HeaderName: 'x-origin-verify', HeaderValue: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('resolve:secretsmanager')])]) }) }],
        })],
      }),
    });
  });

  it('throttles mcp. and serves it only on its custom domain', () => {
    services.hasResourceProperties('AWS::ApiGatewayV2::Api', { DisableExecuteApiEndpoint: true });
    services.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: config.rateLimits.mcpPerSecond, ThrottlingBurstLimit: config.rateLimits.mcpBurst },
    });
    services.hasResourceProperties('AWS::ApiGatewayV2::DomainName', { DomainName: 'mcp.example.com' });
  });

  it('lets only auth. sign tokens and send email, and only mcp. write site files and edge records', () => {
    const policies = Object.entries(services.findResources('AWS::IAM::Policy')).map(([id, p]) => ({ id, text: JSON.stringify(p) }));
    const holders = (action: string) => policies.filter((p) => p.text.includes(action)).map((p) => p.id.replace(/ServiceRole.*/, ''));
    expect(holders('kms:Sign')).toEqual(['AuthFunction']);
    expect(holders('ses:SendEmail')).toEqual(['AuthFunction']);
    expect(holders('cloudfront-keyvaluestore:PutKey')).toEqual(['McpFunction']);
    // Purge and malware findings can only take sites down.
    expect(holders('cloudfront-keyvaluestore:DeleteKey')).toEqual(['McpFunction', 'PurgeFunction', 'ScansFunction']);
    expect(holders('s3:PutObject')).toEqual(['McpFunction']);
  });

  it('lets auth. send only as Passa’s sender', () => {
    const policies = JSON.stringify(services.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('"ses:FromAddress":"no-reply@example.com"');
  });

  it('sends mail through a configuration set that reports bounces and complaints', () => {
    services.hasResourceProperties('AWS::SES::ConfigurationSet', { SuppressionOptions: { SuppressedReasons: ['BOUNCE', 'COMPLAINT'] } });
    services.hasResourceProperties('AWS::SES::ConfigurationSetEventDestination', {
      EventDestination: Match.objectLike({ MatchingEventTypes: ['bounce', 'complaint'], SnsDestination: Match.anyValue() }),
    });
    services.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'lambda' });
  });

  it('emails the admins when SES reputation or a function needs attention', () => {
    for (const admin of config.admins) services.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: admin });
    for (const name of ['bounce-rate', 'complaint-rate', 'auth-errors', 'mcp-errors', 'purge-errors', 'bounces-errors']) {
      services.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: `passa-prod-${name}`, AlarmActions: [Match.anyValue()] });
    }
  });

  it('acts on malware findings in either bucket, alarms on them, and turns on the publish check', () => {
    services.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.guardduty'],
        'detail-type': ['GuardDuty Malware Protection Object Scan Result'],
        detail: Match.objectLike({ scanResultDetails: { scanResultStatus: ['THREATS_FOUND'] } }),
      }),
    });
    services.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: 'passa-prod-malware-found' });
    services.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ PASSA_MALWARE_SCAN: '1' }) } });
  });

  it('purges only on TTL removals of PURGE items', () => {
    const mapping = Object.values(services.findResources('AWS::Lambda::EventSourceMapping'))[0];
    const pattern = JSON.parse(mapping?.Properties.FilterCriteria.Filters[0].Pattern);
    expect(pattern).toEqual({
      eventName: ['REMOVE'],
      userIdentity: { principalId: ['dynamodb.amazonaws.com'] },
      dynamodb: { OldImage: { pk: { S: [{ prefix: 'PURGE#' }] } } },
    });
  });
});
