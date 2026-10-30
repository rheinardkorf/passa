// How the Lambda functions find the deployment's resources: environment
// variables the CDK stacks set. The names live here so both sides agree.
import { type Config, parseConfig } from './config.ts';
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
} as const;

export type RuntimeEnv = {
  config: Config;
  tables: { main: string; events: string };
  buckets: Buckets;
  tokenKey: string;
  authSecret: string;
  edgeStore: string;
  configurationSet?: string;
};

export function runtimeEnv(env: Record<string, string | undefined> = process.env): RuntimeEnv {
  const get = (name: string) => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  const configurationSet = env[ENV.configurationSet];
  return {
    config: parseConfig(JSON.parse(get(ENV.config))),
    tables: { main: get(ENV.table), events: get(ENV.eventsTable) },
    buckets: { sites: get(ENV.sitesBucket), uploads: get(ENV.uploadsBucket) },
    tokenKey: get(ENV.tokenKey),
    authSecret: get(ENV.authSecret),
    edgeStore: get(ENV.edgeStore),
    ...(configurationSet ? { configurationSet } : {}),
  };
}

// The viewer's IP from CloudFront-Viewer-Address ("<ip>:<port>"; IPv6 too).
export function viewerAddress(header: string | undefined): string {
  const value = header ?? '';
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}
