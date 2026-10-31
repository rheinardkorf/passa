// Sites: <site-id>.<siteDomain> served from the sites bucket by CloudFront,
// with the edge handler as a viewer-request CloudFront Function that reads
// KeyValueStore, and the same response headers the local proxy sets.
import { functionCode, responseFunctionCode } from '@passa/edge/build';
import { type Config, siteDomain, siteHeaders } from '@passa/shared';
import { Duration, Stack, type StackProps } from 'aws-cdk-lib';
import type { ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
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
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';
import type { DataStack } from './data.ts';

export type SitesProps = StackProps & {
  config: Config;
  stage: string;
  siteZone: IHostedZone;
  data: DataStack;
  certificate: ICertificate;
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
      customHeaders: Object.entries(custom).map(([header, value]) => ({ header, value, override: true })),
    },
  };
}

export class SitesStack extends Stack {
  readonly distribution: Distribution;

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

    // Decides x-robots-tag by host (M2 R42): the headers policy is the same for every site.
    const robots = new CloudFrontFunction(this, 'Robots', {
      comment: `Passa ${props.stage} sites indexing`,
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(responseFunctionCode(config)),
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `Passa ${props.stage} sites`,
      domainNames: [`*.${sites}`],
      certificate: props.certificate,
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
    });

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
