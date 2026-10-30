import { parseConfig } from '@passa/shared';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { addStage } from './stacks.ts';
import { exampleConfig, testApp } from './testing.ts';

const example = exampleConfig();
const config = parseConfig({
  ...example,
  stages: { dev: { domain: 'dev.example.com', email: { from: 'Passa <no-reply@dev.example.com>' } } },
});

const synth = (stage: 'dev' | 'prod') => {
  const { foundation } = addStage(testApp(), config, stage);
  return { stack: foundation, template: Template.fromStack(foundation) };
};

describe('foundation stack', () => {
  it('creates the zone, SES identity with DKIM and MAIL FROM, and DMARC', () => {
    const { template } = synth('prod');
    template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'example.com.' });
    template.hasResourceProperties('AWS::SES::EmailIdentity', {
      EmailIdentity: 'example.com',
      MailFromAttributes: { MailFromDomain: 'mail.example.com' },
    });
    template.resourceCountIs('AWS::Route53::RecordSet', 3 + 2 + 1); // DKIM, MAIL FROM MX and SPF, DMARC
    template.hasResourceProperties('AWS::Route53::RecordSet', { Name: '_dmarc.example.com.', Type: 'TXT', ResourceRecords: [Match.stringLikeRegexp('p=reject')] });
  });

  it('deploys each stage to its own account, names and domain', () => {
    const prod = synth('prod');
    const dev = synth('dev');
    expect([prod.stack.stackName, prod.stack.account, prod.stack.terminationProtection]).toEqual(['passa-prod-foundation', '111111111111', true]);
    expect([dev.stack.stackName, dev.stack.account, dev.stack.terminationProtection]).toEqual(['passa-dev-foundation', '000000000000', false]);
    dev.template.hasResourceProperties('AWS::Route53::HostedZone', { Name: 'dev.example.com.' });
  });

  it('refuses a sender that is not on the domain', () => {
    const bad = parseConfig({ ...example, email: { from: 'no-reply@elsewhere.com' } });
    expect(() => addStage(testApp(), bad, 'prod')).toThrow(/email.from/);
  });
});
