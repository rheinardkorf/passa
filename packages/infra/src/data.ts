// Everything a deployment stores: the tables, the buckets, the access-token
// signing key, the auth secrets and the edge's KeyValueStore. Production keeps
// all of it if the stack is ever deleted; dev doesn't.
import { authSecretsSchema } from '@passa/auth/secrets';
import { type Config, eventsTable, mainTable } from '@passa/shared';
import { CustomResource, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { KeyValueStore } from 'aws-cdk-lib/aws-cloudfront';
import { AttributeType, Billing, StreamViewType, TableV2, type TablePropsV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Alias, Key, KeySpec, KeyUsage } from 'aws-cdk-lib/aws-kms';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { nodeFunction } from './functions.ts';

export type DataProps = StackProps & { config: Config; stage: string; keep: boolean };

type TableInput = ReturnType<typeof mainTable>;

// CDK table props from the shapes local setup uses, so the two can't drift.
function tableProps(input: TableInput): Pick<TablePropsV2, 'partitionKey' | 'sortKey' | 'globalSecondaryIndexes'> {
  const attr = (name: string) => ({ name, type: AttributeType.STRING });
  const keyOf = (schema: TableInput['KeySchema'], type: 'HASH' | 'RANGE') => schema?.find((k) => k.KeyType === type)?.AttributeName;
  const hash = keyOf(input.KeySchema, 'HASH');
  const range = keyOf(input.KeySchema, 'RANGE');
  if (!hash) throw new Error(`${input.TableName} has no partition key`);
  return {
    partitionKey: attr(hash),
    ...(range ? { sortKey: attr(range) } : {}),
    globalSecondaryIndexes: (input.GlobalSecondaryIndexes ?? []).map((index) => {
      const indexHash = keyOf(index.KeySchema, 'HASH');
      const indexRange = keyOf(index.KeySchema, 'RANGE');
      if (!index.IndexName || !indexHash) throw new Error(`${input.TableName} has an incomplete index`);
      return { indexName: index.IndexName, partitionKey: attr(indexHash), ...(indexRange ? { sortKey: attr(indexRange) } : {}) };
    }),
  };
}

export class DataStack extends Stack {
  readonly table: TableV2;
  readonly events: TableV2;
  readonly sites: Bucket;
  readonly uploads: Bucket;
  readonly tokenKey: Key;
  readonly tokenKeyAlias: Alias;
  readonly authSecret: Secret;
  readonly edgeStore: KeyValueStore;
  readonly removalPolicy: RemovalPolicy;

  constructor(scope: Construct, id: string, props: DataProps) {
    super(scope, id, props);
    const prefix = `passa-${props.stage}`;
    const removalPolicy = props.keep ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    this.removalPolicy = removalPolicy;
    const table = { billing: Billing.onDemand(), pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }, deletionProtection: props.keep, removalPolicy };

    // The stream carries deleted items, so a PURGE item's TTL can trigger the hard delete.
    this.table = new TableV2(this, 'Table', {
      ...table,
      ...tableProps(mainTable(prefix)),
      tableName: prefix,
      timeToLiveAttribute: 'ttl',
      dynamoStream: StreamViewType.OLD_IMAGE,
    });
    this.events = new TableV2(this, 'Events', { ...table, ...tableProps(eventsTable(`${prefix}-events`)), tableName: `${prefix}-events` });

    const bucket = { blockPublicAccess: BlockPublicAccess.BLOCK_ALL, encryption: BucketEncryption.S3_MANAGED, enforceSSL: true, objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED, removalPolicy, autoDeleteObjects: !props.keep };
    this.sites = new Bucket(this, 'Sites', bucket);
    // CloudFront reads site files through Origin Access Control. Naming the
    // sites distribution here would make the stacks depend on each other, so
    // the grant is to this account's distributions.
    this.sites.addToResourcePolicy(new PolicyStatement({
      principals: [new ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [this.sites.arnForObjects('*')],
      conditions: { StringEquals: { 'AWS:SourceAccount': this.account }, ArnLike: { 'AWS:SourceArn': `arn:${this.partition}:cloudfront::${this.account}:distribution/*` } },
    }));
    // Uploads are only staged here until publish copies them; S3 expires the rest.
    this.uploads = new Bucket(this, 'Uploads', { ...bucket, lifecycleRules: [{ expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }] });

    // Access tokens are signed in KMS; the private key never leaves it.
    this.tokenKey = new Key(this, 'TokenKey', { keySpec: KeySpec.ECC_NIST_P256, keyUsage: KeyUsage.SIGN_VERIFY, description: `${prefix} access tokens`, removalPolicy });
    this.tokenKeyAlias = this.tokenKey.addAlias(`alias/${prefix}-tokens`);

    this.authSecret = new Secret(this, 'AuthSecret', { secretName: `${prefix}-auth`, description: 'Cookie keys for auth. and the edge', removalPolicy });
    this.edgeStore = new KeyValueStore(this, 'EdgeStore', { keyValueStoreName: `${prefix}-edge` });

    // Fills the secret on first deploy and copies the site keys to the edge.
    const keysFn = nodeFunction(this, 'KeysFunction', {
      entry: 'packages/infra/src/functions/keys.ts',
      environment: { SECRET_ID: this.authSecret.secretArn, KVS_ARN: this.edgeStore.keyValueStoreArn },
      removalPolicy,
    });
    this.authSecret.grantRead(keysFn);
    this.authSecret.grantWrite(keysFn);
    keysFn.addToRolePolicy(kvsWritePolicy(this.edgeStore));
    const provider = new Provider(this, 'KeysProvider', { onEventHandler: keysFn });
    // The field list is a property, so a new field runs it again on deploy.
    new CustomResource(this, 'Keys', {
      serviceToken: provider.serviceToken,
      properties: { secret: this.authSecret.secretArn, store: this.edgeStore.keyValueStoreArn, fields: Object.keys(authSecretsSchema.shape).join(',') },
    });
  }
}

// KeyValueStore's data-plane API.
export function kvsWritePolicy(store: KeyValueStore): PolicyStatement {
  return new PolicyStatement({
    actions: ['cloudfront-keyvaluestore:DescribeKeyValueStore', 'cloudfront-keyvaluestore:GetKey', 'cloudfront-keyvaluestore:PutKey', 'cloudfront-keyvaluestore:DeleteKey'],
    resources: [store.keyValueStoreArn],
  });
}
