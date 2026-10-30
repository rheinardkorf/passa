// The two services. auth.<domain>: CloudFront with WAF in front of a Lambda
// function URL, which only answers requests carrying CloudFront's secret
// origin header. mcp.<domain>: an API Gateway HTTP API with throttling, on its
// custom domain only (R20, R21).
import { type Config, ENV, senderAddress } from '@passa/shared';
import { Duration, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import { DomainName, HttpApi, HttpStage } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Certificate, CertificateValidation, type ICertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HttpVersion,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { FunctionUrlOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { FilterCriteria, FilterRule, FunctionUrlAuthType, StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { AaaaRecord, ARecord, type IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { ApiGatewayv2DomainProperties, CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { ConfigurationSet, EmailSendingEvent, EventDestination, SuppressionReasons } from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription, LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { type DataStack, kvsWritePolicy } from './data.ts';
import { nodeFunction } from './functions.ts';

export type ServicesProps = StackProps & {
  config: Config;
  stage: string;
  zone: IHostedZone;
  data: DataStack;
  authCertificate: ICertificate;
  webAclArn: string;
};

// Copies the viewer's host into a header the function can read, since the
// function URL origin needs its own Host header. Viewers can't set it: this
// overwrites whatever they send.
const FORWARD_HOST = "function handler(event){var r=event.request;r.headers['x-passa-host']={value:r.headers.host.value};return r;}";

export class ServicesStack extends Stack {
  readonly authDistribution: Distribution;
  readonly mcpApi: HttpApi;

  constructor(scope: Construct, id: string, props: ServicesProps) {
    super(scope, id, props);
    const { config, data, zone } = props;
    const { domain, rateLimits } = config;
    const prefix = `passa-${props.stage}`;

    // Mail goes through a configuration set that reports bounces and
    // complaints, and SES stops sending to those addresses.
    const mail = new ConfigurationSet(this, 'Mail', {
      configurationSetName: prefix,
      suppressionReasons: SuppressionReasons.BOUNCES_AND_COMPLAINTS,
      reputationMetrics: true,
    });

    const environment = {
      [ENV.config]: JSON.stringify(config),
      [ENV.table]: data.table.tableName,
      [ENV.eventsTable]: data.events.tableName,
      [ENV.sitesBucket]: data.sites.bucketName,
      [ENV.uploadsBucket]: data.uploads.bucketName,
      [ENV.tokenKey]: data.tokenKeyAlias.aliasName,
      [ENV.authSecret]: data.authSecret.secretArn,
      [ENV.edgeStore]: data.edgeStore.keyValueStoreArn,
      [ENV.configurationSet]: mail.configurationSetName,
      [ENV.malwareScan]: '1',
      NODE_OPTIONS: '--enable-source-maps',
    };

    // auth.<domain>
    const auth = nodeFunction(this, 'AuthFunction', {
      entry: 'packages/auth/src/lambda.ts',
      environment,
      description: `Passa ${props.stage} auth.`,
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(auth);
    data.events.grantWriteData(auth);
    data.authSecret.grantRead(auth);
    data.tokenKey.grant(auth, 'kms:Sign', 'kms:GetPublicKey', 'kms:DescribeKey');
    // SES checks every identity involved, and in its sandbox that includes the
    // verified recipient, so any identity is allowed, but only from Passa's sender.
    auth.addToRolePolicy(new PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [
        this.formatArn({ service: 'ses', resource: 'identity', resourceName: '*' }),
        this.formatArn({ service: 'ses', resource: 'configuration-set', resourceName: mail.configurationSetName }),
      ],
      conditions: { StringEquals: { 'ses:FromAddress': senderAddress(config.email.from) } },
    }));
    const authUrl = auth.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    // The origin header's value stays in Secrets Manager; CloudFormation resolves it at deploy.
    const originVerify = SecretValue.secretsManager(data.authSecret.secretArn, { jsonField: 'originVerify' }).unsafeUnwrap();
    this.authDistribution = new Distribution(this, 'AuthDistribution', {
      comment: `Passa ${props.stage} auth.`,
      domainNames: [`auth.${domain}`],
      certificate: props.authCertificate,
      webAclId: props.webAclArn,
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: new FunctionUrlOrigin(authUrl, { customHeaders: { 'x-origin-verify': originVerify } }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        // Everything from the viewer except Host, plus CloudFront-Viewer-Address.
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [{
          eventType: FunctionEventType.VIEWER_REQUEST,
          function: new CloudFrontFunction(this, 'ForwardHost', { runtime: FunctionRuntime.JS_2_0, code: FunctionCode.fromInline(FORWARD_HOST) }),
        }],
      },
    });
    const authTarget = RecordTarget.fromAlias(new CloudFrontTarget(this.authDistribution));
    new ARecord(this, 'AuthA', { zone, recordName: 'auth', target: authTarget });
    new AaaaRecord(this, 'AuthAaaa', { zone, recordName: 'auth', target: authTarget });

    // mcp.<domain>
    const mcp = nodeFunction(this, 'McpFunction', {
      entry: 'packages/mcp/src/lambda.ts',
      environment,
      description: `Passa ${props.stage} mcp.`,
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(mcp);
    data.events.grantWriteData(mcp);
    data.sites.grantReadWrite(mcp);
    data.uploads.grantReadWrite(mcp);
    data.tokenKey.grant(mcp, 'kms:GetPublicKey', 'kms:DescribeKey');
    mcp.addToRolePolicy(kvsWritePolicy(data.edgeStore));

    const mcpDomain = new DomainName(this, 'McpDomain', {
      domainName: `mcp.${domain}`,
      certificate: new Certificate(this, 'McpCertificate', { domainName: `mcp.${domain}`, validation: CertificateValidation.fromDns(zone) }),
    });
    // Only the custom domain: the default execute-api address is off.
    this.mcpApi = new HttpApi(this, 'McpApi', {
      apiName: `passa-${props.stage}-mcp`,
      defaultIntegration: new HttpLambdaIntegration('McpIntegration', mcp),
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
    });
    new HttpStage(this, 'McpStage', {
      httpApi: this.mcpApi,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: rateLimits.mcpPerSecond, burstLimit: rateLimits.mcpBurst },
      domainMapping: { domainName: mcpDomain },
    });
    const mcpTarget = RecordTarget.fromAlias(new ApiGatewayv2DomainProperties(mcpDomain.regionalDomainName, mcpDomain.regionalHostedZoneId));
    new ARecord(this, 'McpA', { zone, recordName: 'mcp', target: mcpTarget });
    new AaaaRecord(this, 'McpAaaa', { zone, recordName: 'mcp', target: mcpTarget });

    // Hard deletes: the table stream, filtered to TTL removals of PURGE items.
    const purge = nodeFunction(this, 'PurgeFunction', {
      entry: 'packages/mcp/src/purge.ts',
      environment,
      description: `Passa ${props.stage} purge`,
      timeout: Duration.minutes(5),
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(purge);
    data.events.grantWriteData(purge);
    data.sites.grantRead(purge);
    data.sites.grantDelete(purge);
    purge.addToRolePolicy(kvsWritePolicy(data.edgeStore, 'remove'));
    // TableV2's typings clash with exactOptionalPropertyTypes; it is an ITable.
    purge.addEventSource(new DynamoEventSource(data.table as unknown as ITable, {
      startingPosition: StartingPosition.LATEST,
      retryAttempts: 10,
      filters: [FilterCriteria.filter({
        eventName: FilterRule.isEqual('REMOVE'),
        userIdentity: { principalId: FilterRule.isEqual('dynamodb.amazonaws.com') },
        dynamodb: { OldImage: { pk: { S: FilterRule.beginsWith('PURGE#') } } },
      }), FilterCriteria.filter({
        eventName: FilterRule.isEqual('REMOVE'),
        userIdentity: { principalId: FilterRule.isEqual('dynamodb.amazonaws.com') },
        dynamodb: { OldImage: { pk: { S: FilterRule.beginsWith('NAME#') } } },
      })],
    }));

    // Bounces and complaints: SES → SNS → a function that stops emailing the address.
    const mailEvents = new Topic(this, 'MailEvents', { enforceSSL: true });
    mailEvents.addToResourcePolicy(new PolicyStatement({
      principals: [new ServicePrincipal('ses.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [mailEvents.topicArn],
      conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
    }));
    mail.addEventDestination('Undeliverable', {
      destination: EventDestination.snsTopic(mailEvents),
      events: [EmailSendingEvent.BOUNCE, EmailSendingEvent.COMPLAINT],
    });
    const bounces = nodeFunction(this, 'BouncesFunction', {
      entry: 'packages/auth/src/bounces.ts',
      environment,
      description: `Passa ${props.stage} bounces and complaints`,
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(bounces);
    data.events.grantWriteData(bounces);
    mailEvents.addSubscription(new LambdaSubscription(bounces));

    // Alarms, emailed to the admins (each confirms the subscription once).
    const alerts = new Topic(this, 'Alerts', { topicName: `${prefix}-alerts`, enforceSSL: true });
    for (const admin of config.admins) alerts.addSubscription(new EmailSubscription(admin));
    const alarm = (id: string, metric: Metric, threshold: number, description: string) =>
      new Alarm(this, id, {
        alarmName: `${prefix}-${id}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new SnsAction(alerts));
    // SES reviews accounts above about 5% bounces or 0.1% complaints; warn well before.
    const reputation = (metricName: string) => new Metric({ namespace: 'AWS/SES', metricName, statistic: 'Maximum', period: Duration.hours(1) });
    alarm('bounce-rate', reputation('Reputation.BounceRate'), 0.02, 'SES bounce rate is high');
    alarm('complaint-rate', reputation('Reputation.ComplaintRate'), 0.0005, 'SES complaint rate is high');
    // Malware findings (GuardDuty scans both buckets, see the data stack).
    const scans = nodeFunction(this, 'ScansFunction', {
      entry: 'packages/mcp/src/scans.ts',
      environment,
      description: `Passa ${props.stage} malware findings`,
      removalPolicy: data.removalPolicy,
    });
    data.table.grantReadWriteData(scans);
    data.events.grantWriteData(scans);
    scans.addToRolePolicy(kvsWritePolicy(data.edgeStore, 'remove'));
    const findings = new Rule(this, 'MalwareFindings', {
      description: 'GuardDuty found malware in a Passa bucket',
      eventPattern: {
        source: ['aws.guardduty'],
        detailType: ['GuardDuty Malware Protection Object Scan Result'],
        detail: {
          scanResultDetails: { scanResultStatus: ['THREATS_FOUND'] },
          s3ObjectDetails: { bucketName: [data.sites.bucketName, data.uploads.bucketName] },
        },
      },
      targets: [new LambdaFunction(scans, { retryAttempts: 10 })],
    });
    alarm('malware-found', new Metric({ namespace: 'AWS/Events', metricName: 'MatchedEvents', dimensionsMap: { RuleName: findings.ruleName }, statistic: 'Sum', period: Duration.minutes(5) }), 1, 'GuardDuty found malware in a published or uploaded file');

    for (const [name, fn, threshold] of [['auth', auth, 5], ['mcp', mcp, 5], ['purge', purge, 1], ['bounces', bounces, 1], ['scans', scans, 1]] as const) {
      alarm(`${name}-errors`, fn.metricErrors({ period: Duration.minutes(5), statistic: 'Sum' }), threshold, `Passa ${name} function errors`);
    }

  }
}
