import { parseConfig } from '@passa/shared/config-file';
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

  it('lets only auth. sign tokens, only the mail function send email, only mcp. write site files and edge records, and the cards function write cards', () => {
    const policies = Object.entries(services.findResources('AWS::IAM::Policy')).map(([id, p]) => ({ id, text: JSON.stringify(p) }));
    const holders = (action: string) => policies.filter((p) => p.text.includes(action)).map((p) => p.id.replace(/ServiceRole.*/, ''));
    expect(holders('kms:Sign')).toEqual(['AuthFunction']);
    expect(holders('ses:SendEmail')).toEqual(['MailFunction']);
    expect(holders('cloudfront-keyvaluestore:PutKey')).toEqual(['McpFunction']);
    // Purge and malware findings can only take sites down.
    expect(holders('cloudfront-keyvaluestore:DeleteKey')).toEqual(['McpFunction', 'PurgeFunction', 'ScansFunction']);
    expect(holders('s3:PutObject')).toEqual(['CardsFunction', 'McpFunction']);
    const cards = policies.find((p) => p.id.startsWith('CardsFunction'))?.text ?? '';
    expect(cards).toContain('/*/cards/*');
    expect(cards).not.toContain('s3:DeleteObject');
  });

  it('lets the mail function send only as Passa’s sender', () => {
    const policies = JSON.stringify(services.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('"ses:FromAddress":"no-reply@example.com"');
  });

  it('hands auth.’s mail to the mail function in the background, and reads an SMTP password only when config uses SMTP (M5 R141, R145)', () => {
    const fns = services.findResources('AWS::Lambda::Function');
    const auth = Object.entries(fns).find(([id]) => id.startsWith('AuthFunction'))?.[1];
    expect(auth?.Properties.Environment.Variables.PASSA_MAIL_FUNCTION).toEqual({ Ref: expect.stringMatching(/^MailFunction/) });
    const policies = Object.entries(services.findResources('AWS::IAM::Policy')).map(([id, p]) => ({ id, text: JSON.stringify(p) }));
    expect(policies.find((p) => p.id.startsWith('AuthFunction'))?.text).toContain('lambda:InvokeFunction');
    expect(JSON.stringify(policies)).not.toContain('ssm:GetParameter');
    const smtp = Template.fromStack(addStage(testApp(), parseConfig({ ...exampleConfig(), email: { from: 'Passa <passa@example.com>', provider: 'smtp', smtp: { host: 'smtp.example.com', port: 465, user: 'passa@example.com', passwordParameter: '/passa/prod/smtp-password' } } }), 'prod').services);
    const smtpPolicies = Object.entries(smtp.findResources('AWS::IAM::Policy')).map(([id, p]) => ({ id, text: JSON.stringify(p) }));
    const reading = smtpPolicies.filter((p) => p.text.includes('ssm:GetParameter')).map((p) => p.id.replace(/ServiceRole.*/, ''));
    expect(reading).toEqual(['MailFunction']);
    expect(smtpPolicies.find((p) => p.id.startsWith('MailFunction'))?.text).toContain('parameter/passa/prod/smtp-password');
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

  it('acts on malware findings in the uploads bucket, alarms on them, and turns on the publish check', () => {
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

  it('runs only on TTL removals of PURGE and NAME items', () => {
    const mapping = Object.values(services.findResources('AWS::Lambda::EventSourceMapping'))[0];
    const patterns = (mapping?.Properties.FilterCriteria.Filters as { Pattern: string }[]).map((f) => JSON.parse(f.Pattern));
    expect(patterns).toEqual(['PURGE#', 'NAME#'].map((prefix) => ({
      eventName: ['REMOVE'],
      userIdentity: { principalId: ['dynamodb.amazonaws.com'] },
      dynamodb: { OldImage: { pk: { S: [{ prefix }] } } },
    })));
  });

  it('removes old versions once a day, with no access to the edge or to write files', () => {
    const [id] = Object.keys(services.findResources('AWS::Lambda::Function', { Properties: { Description: 'Passa prod version retention' } }));
    services.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'cron(0 17 * * ? *)',
      Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [id, 'Arn'] } })],
    });
    const policy = JSON.stringify(Object.entries(services.findResources('AWS::IAM::Policy')).find(([key]) => key.startsWith('RetentionFunction')));
    expect(policy).toContain('s3:DeleteObject');
    expect(policy).not.toContain('s3:PutObject');
    expect(policy).not.toContain('cloudfront-keyvaluestore');
  });
});
