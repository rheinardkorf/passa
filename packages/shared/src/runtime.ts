// How the Lambda functions find the deployment's resources: environment
// variables the CDK stacks set. The names live here so both sides agree.
import type { Config } from './config.ts';
import type { Buckets } from './storage.ts';

export const ENV = {
  config: 'PASSA_CONFIG', // the stage's config, as JSON (it holds no secrets)
  table: 'PASSA_TABLE',
  eventsTable: 'PASSA_EVENTS_TABLE',
  sitesBucket: 'PASSA_SITES_BUCKET',
  uploadsBucket: 'PASSA_UPLOADS_BUCKET',
  tokenKey: 'PASSA_TOKEN_KEY', // KMS key ID, ARN or alias
  authSecret: 'PASSA_AUTH_SECRET',
  edgeStore: 'PASSA_EDGE_STORE', // KeyValueStore ARN
  configurationSet: 'PASSA_SES_CONFIGURATION_SET', // optional: reports bounces and complaints
  malwareScan: 'PASSA_MALWARE_SCAN', // "1" when GuardDuty scans the buckets
  cardsFunction: 'PASSA_CARDS_FUNCTION', // optional: draws the social cards a publish had no time for
  mailFunction: 'PASSA_MAIL_FUNCTION', // optional: sends email in the background (M5 R145)
  // The admin function's (M4): the multi-tenant distribution custom domains
  // attach to, and its connection group.
  domainsDistribution: 'PASSA_DOMAINS_DISTRIBUTION',
  domainsConnectionGroup: 'PASSA_DOMAINS_CONNECTION_GROUP',
} as const;

export type RuntimeEnv = {
  config: Config;
  tables: { main: string; events: string };
  buckets: Buckets;
  tokenKey: string;
  authSecret: string;
  edgeStore: string;
  configurationSet?: string;
  malwareScan: boolean;
  cardsFunction?: string;
  mailFunction?: string;
};

// The config the CDK stacks wrote, already validated against the schema at
// deploy time (loadConfigFile), so functions don't carry the schema library.
function readConfig(json: string): Config {
  const config: unknown = JSON.parse(json);
  if (!config || typeof config !== 'object' || typeof (config as Config).domain !== 'string' || !Array.isArray((config as Config).cdnAllowlist)) {
    throw new Error(`${ENV.config} isn't a Passa config`);
  }
  return config as Config;
}

export function runtimeEnv(env: Record<string, string | undefined> = process.env): RuntimeEnv {
  const get = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const configurationSet = env[ENV.configurationSet];
  const cardsFunction = env[ENV.cardsFunction];
  const mailFunction = env[ENV.mailFunction];
  return {
    config: readConfig(get(ENV.config)),
    tables: { main: get(ENV.table), events: get(ENV.eventsTable) },
    buckets: { sites: get(ENV.sitesBucket), uploads: get(ENV.uploadsBucket) },
    tokenKey: get(ENV.tokenKey),
    authSecret: get(ENV.authSecret),
    edgeStore: get(ENV.edgeStore),
    ...(configurationSet ? { configurationSet } : {}),
    malwareScan: env[ENV.malwareScan] === '1',
    ...(cardsFunction ? { cardsFunction } : {}),
    ...(mailFunction ? { mailFunction } : {}),
  };
}

// The viewer's IP from CloudFront-Viewer-Address ("<ip>:<port>"; IPv6 too).
export function viewerAddress(header: string | undefined): string {
  const value = header ?? '';
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}
