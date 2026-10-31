import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { addStage } from './stacks.ts';
import { exampleConfig, testApp } from './testing.ts';

const config = exampleConfig();
const synth = (stage: 'dev' | 'prod') => Template.fromStack(addStage(testApp(), config, stage).data);

describe('data stack', () => {
  it('creates the main table with the same keys local setup uses, TTL, PITR and a stream', () => {
    synth('prod').hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TableName: 'passa-prod',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'gsi1' })],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      StreamSpecification: { StreamViewType: 'OLD_IMAGE' },
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true })],
    });
  });

  it('keeps production data if the stack is deleted, but not dev data', () => {
    const retained = (template: Template, type: string) => Object.values(template.findResources(type)).every((r) => r.DeletionPolicy === 'Retain');
    const prod = synth('prod');
    const dev = synth('dev');
    for (const type of ['AWS::DynamoDB::GlobalTable', 'AWS::S3::Bucket', 'AWS::KMS::Key', 'AWS::SecretsManager::Secret']) {
      expect(retained(prod, type), type).toBe(true);
      expect(retained(dev, type), type).toBe(false);
    }
  });

  it('blocks public access to the buckets and expires uploads', () => {
    const template = synth('prod');
    template.allResourcesProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    });
    template.hasResourceProperties('AWS::S3::Bucket', { LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 1 })] } });
  });

  it('scans the uploads bucket only, where new site files are staged, and tags each object with the result', () => {
    const template = synth('prod');
    template.resourceCountIs('AWS::GuardDuty::MalwareProtectionPlan', 1);
    const [uploads] = Object.keys(template.findResources('AWS::S3::Bucket', { Properties: { LifecycleConfiguration: Match.anyValue() } }));
    template.hasResourceProperties('AWS::GuardDuty::MalwareProtectionPlan', { ProtectedResource: { S3Bucket: { BucketName: { Ref: uploads } } } });
    template.allResourcesProperties('AWS::GuardDuty::MalwareProtectionPlan', { Actions: { Tagging: { Status: 'ENABLED' } } });
  });

  it('expires events with a TTL', () => {
    synth('prod').hasResourceProperties('AWS::DynamoDB::GlobalTable', { TableName: 'passa-prod-events', TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } });
  });

  it('signs access tokens with a P-256 key in KMS', () => {
    synth('prod').hasResourceProperties('AWS::KMS::Key', { KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' });
  });

  it('lets only the keys function write the edge store', () => {
    const template = synth('prod');
    const writers = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p).includes('cloudfront-keyvaluestore:PutKey'));
    expect(writers).toHaveLength(1);
  });
});
