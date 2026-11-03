// Sites: <site-id>.<siteDomain> served from the sites bucket by CloudFront,
// with the edge handler as a viewer-request CloudFront Function that reads
// KeyValueStore, and the same response headers the local proxy sets. Custom
// domains (M4) are tenants of a second, multi-tenant distribution with the
// same behaviour, attached at runtime by the admin function.

import { functionCode, responseFunctionCode } from '@passa/edge/build';
import { type Config, ENV, siteDomain, siteHeaders } from '@passa/shared';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  CfnConnectionGroup,
  type CfnDistribution,
  Distribution,
  type DistributionProps,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersReferrerPolicy,
  HttpVersion,
  ResponseHeadersPolicy,
  type ResponseHeadersPolicyProps,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import { type DataStack, kvsWritePolicy } from './data.ts';
import { nodeFunction } from './functions.ts';

export type SitesProps = StackProps & {
  config: Config;
  stage: string;
  siteZone: IHostedZone;
  data: DataStack;
  certificate: ICertificate;
  // Draws the cards a re-render had no time for (services stack).
  cards?: IFunction;
};

// Storage misses (S3 says 403, since CloudFront can't list the bucket) get
// the same plain page as the edge's own 404, instead of S3's error XML.
const NOT_FOUND_KEY = '_passa/not-found.txt';

// The site headers as a CloudFront response headers policy. CloudFront takes
// some security headers only in their own fields, so those are mapped, and any
// value it can't express exactly is an error rather than a silent difference.
export function responseHeadersPolicy(headers: Record<string, string>): ResponseHeadersPolicyProps {
  const {
    'content-security-policy': contentSecurityPolicy,
    'strict-transport-security': hsts,
    'x-content-type-options': contentTypeOptions,
    'referrer-policy': referrerPolicy,
    ...custom
  } = headers;
  const maxAge = /^max-age=(\d+); includeSubDomains$/.exec(hsts ?? '')?.[1];
  if (!contentSecurityPolicy || !maxAge || contentTypeOptions !== 'nosniff' || referrerPolicy !== HeadersReferrerPolicy.NO_REFERRER) {
    throw new Error('site headers changed: update responseHeadersPolicy to match');
  }
  return {
    securityHeadersBehavior: {
      contentSecurityPolicy: { contentSecurityPolicy, override: true },
      strictTransportSecurity: { accessControlMaxAge: Duration.seconds(Number(maxAge)), includeSubdomains: true, override: true },
      contentTypeOptions: { override: true },
      referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.NO_REFERRER, override: true },
    },
    customHeadersBehavior: {
      // The viewer-response function relaxes cross-origin-resource-policy for
      // public files (edge/src/response.js), so it doesn't override that one.
      customHeaders: Object.entries(custom).map(([header, value]) => ({ header, value, override: header !== 'cross-origin-resource-policy' })),
    },
  };
}

export class SitesStack extends Stack {
  readonly distribution: Distribution;
  readonly domainsDistribution: Distribution;
  readonly connectionGroup: CfnConnectionGroup;

  constructor(scope: Construct, id: string, props: SitesProps) {
    super(scope, id, props);
    const { config, data } = props;
    const sites = siteDomain(config);
    const sitesBucket = Bucket.fromBucketAttributes(this, 'SitesBucket', { bucketArn: data.sites.bucketArn, bucketName: data.sites.bucketName });

    // The handler is built with a placeholder ID, then given the store's real one.
    const placeholder = 'passa-kvs-placeholder';
    const code = functionCode(placeholder, config).split(placeholder).join(data.edgeStore.keyValueStoreId);
    const edge = new CloudFrontFunction(this, 'Edge', {
      comment: `Passa ${props.stage} sites`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(code),
      keyValueStore: data.edgeStore,
    });

    // Decides x-robots-tag by host (M2 R42), and lets other sites embed public
    // files: the headers policy is the same for every site and response.
    const robots = new CloudFrontFunction(this, 'Robots', {
      comment: `Passa ${props.stage} sites indexing`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(responseFunctionCode(config)),
    });

    const serving: DistributionProps = {
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        // Imported, so the bucket policy stays in the data stack (which grants the read).
        origin: S3BucketOrigin.withOriginAccessControl(sitesBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        // The handler rewrites each request to its version's path, which is the cache key.
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: new ResponseHeadersPolicy(this, 'Headers', responseHeadersPolicy(siteHeaders(config))),
        functionAssociations: [
          { eventType: FunctionEventType.VIEWER_REQUEST, function: edge },
          { eventType: FunctionEventType.VIEWER_RESPONSE, function: robots },
        ],
      },
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 404, responsePagePath: `/${NOT_FOUND_KEY}`, ttl: Duration.minutes(1) })),
    };
    this.distribution = new Distribution(this, 'Distribution', { ...serving, comment: `Passa ${props.stage} sites`, domainNames: [`*.${sites}`], certificate: props.certificate });

    // Custom domains (M4 R121): the same behaviour on a multi-tenant
    // distribution. It has no address or certificate of its own: each domain
    // is a tenant with its own certificate, reached through the connection
    // group's routing endpoint. CDK's Distribution can't make one yet, so the
    // mode is set on the CloudFormation resource.
    this.domainsDistribution = new Distribution(this, 'DomainsDistribution', { ...serving, comment: `Passa ${props.stage} custom domains` });
    const cfn = this.domainsDistribution.node.defaultChild as CfnDistribution;
    cfn.addPropertyOverride('DistributionConfig.ConnectionMode', 'tenant-only');
    // Settings a multi-tenant distribution doesn't take: IPv6 is the
    // connection group's, and every edge location serves tenants.
    cfn.addPropertyDeletionOverride('DistributionConfig.IPV6Enabled');
    cfn.addPropertyDeletionOverride('DistributionConfig.PriceClass');
    // Tenants bring their own certificates, always over SNI; without this the
    // TLS floor defaults to SSLv3, which CloudFront refuses alongside SNI.
    cfn.addPropertyOverride('DistributionConfig.ViewerCertificate', { CloudFrontDefaultCertificate: true, SslSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' });
    this.connectionGroup = new CfnConnectionGroup(this, 'DomainsConnectionGroup', { name: `passa-${props.stage}-domains`, ipv6Enabled: true, enabled: true });

    // passa admin (M4 R113): invoked with AWS credentials, never through MCP.
    const admin = nodeFunction(this, 'AdminFunction', {
      entry: 'packages/admin/src/lambda.ts',
      description: `Passa ${props.stage} admin`,
      environment: {
        [ENV.config]: JSON.stringify(config),
        [ENV.table]: data.table.tableName,
        [ENV.eventsTable]: data.events.tableName,
        [ENV.sitesBucket]: data.sites.bucketName,
        [ENV.uploadsBucket]: data.uploads.bucketName,
        [ENV.tokenKey]: data.tokenKeyAlias.aliasName,
        [ENV.authSecret]: data.authSecret.secretArn,
        [ENV.edgeStore]: data.edgeStore.keyValueStoreArn,
        [ENV.malwareScan]: '1',
        [ENV.domainsDistribution]: this.domainsDistribution.distributionId,
        [ENV.domainsConnectionGroup]: this.connectionGroup.attrId,
        ...(props.cards ? { [ENV.cardsFunction]: props.cards.functionName } : {}),
        NODE_OPTIONS: '--enable-source-maps',
      },
      // Moving a site to a new primary domain renders its Markdown again.
      memorySize: 1769,
      timeout: Duration.minutes(1),
      cards: true,
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(admin);
    data.events.grantWriteData(admin);
    data.sites.grantReadWrite(admin);
    // Re-rendered files are staged in the uploads bucket for scanning, as on publish.
    data.uploads.grantReadWrite(admin);
    admin.addToRolePolicy(kvsWritePolicy(data.edgeStore));
    props.cards?.grantInvoke(admin);
    const tenants = `arn:${this.partition}:cloudfront::${this.account}:distribution-tenant/*`;
    admin.addToRolePolicy(new PolicyStatement({
      actions: ['cloudfront:CreateDistributionTenant', 'cloudfront:UpdateDistributionTenant', 'cloudfront:GetDistributionTenant', 'cloudfront:DeleteDistributionTenant', 'cloudfront:TagResource'],
      resources: [this.domainsDistribution.distributionArn, tenants],
    }));
    admin.addToRolePolicy(new PolicyStatement({ actions: ['cloudfront:GetConnectionGroup'], resources: [this.connectionGroup.attrArn] }));
    // Listing can't be scoped to one distribution.
    admin.addToRolePolicy(new PolicyStatement({ actions: ['cloudfront:ListDistributionTenants'], resources: ['*'] }));
    // Certificates: requested tagged for Passa, and only those touched after.
    admin.addToRolePolicy(new PolicyStatement({
      actions: ['acm:RequestCertificate', 'acm:AddTagsToCertificate'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestTag/project': 'passa' } },
    }));
    admin.addToRolePolicy(new PolicyStatement({
      actions: ['acm:DescribeCertificate', 'acm:DeleteCertificate'],
      resources: [`arn:${this.partition}:acm:us-east-1:${this.account}:certificate/*`],
      conditions: { StringEquals: { 'aws:ResourceTag/project': 'passa' } },
    }));
    // DNS: only the zones config lists.
    if (config.domains.zones.length) {
      admin.addToRolePolicy(new PolicyStatement({
        actions: ['route53:GetHostedZone', 'route53:ChangeResourceRecordSets'],
        resources: config.domains.zones.map((zone) => `arn:${this.partition}:route53:::hostedzone/${zone}`),
      }));
    }

    const target = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, 'SitesA', { zone: props.siteZone, recordName: `*.${sites}.`, target });
    new AaaaRecord(this, 'SitesAaaa', { zone: props.siteZone, recordName: `*.${sites}.`, target });

    const putNotFound = {
      service: 'S3',
      action: 'putObject',
      parameters: { Bucket: data.sites.bucketName, Key: NOT_FOUND_KEY, Body: 'Not found', ContentType: 'text/plain; charset=utf-8', CacheControl: 'no-store' },
      physicalResourceId: PhysicalResourceId.of(NOT_FOUND_KEY),
    };
    new AwsCustomResource(this, 'NotFoundPage', {
      onCreate: putNotFound,
      onUpdate: putNotFound,
      policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: [data.sites.arnForObjects(NOT_FOUND_KEY)] }),
      installLatestAwsSdk: false,
    });
  }
}
