// The config schema and the config file loader: zod and yaml live only here,
// for the infra (which validates config.yml before writing it into the
// functions' environment), local development and tests. Lambdas read the
// already-validated config with runtimeEnv() and never load this module.
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// The deployment's config, as written in config.yml (see config.example.yml).
// Every lifetime, limit and flag lives here rather than in code.
const seconds = z.number().int().positive();
const bytes = z.number().int().positive();
const domainName = z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/);
const timeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, 'an IANA time zone, such as UTC or Australia/Sydney');
const email = z.strictObject({ from: z.string().min(1) });

// What a stage can change: dev usually runs on its own subdomains.
// Custom domains (M4): the Route 53 hosted zones (by ID) Passa may write
// records in, and how many names share a tenant's certificate (ACM's default
// limit is 10 names per certificate).
const domains = z.strictObject({
  zones: z.array(z.string().regex(/^Z[A-Z0-9]{1,32}$/)).default([]),
  namesPerTenant: z.number().int().min(1).max(100).default(10),
});

const stageOverrides = z.strictObject({
  domain: domainName.optional(),
  siteDomain: domainName.optional(),
  email: email.optional(),
  domains: domains.optional(),
});

export const configSchema = z.strictObject({
  domain: domainName,
  siteDomain: domainName.optional(),
  region: z.string().min(1),
  accounts: z.strictObject({ dev: z.string().regex(/^\d{12}$/), prod: z.string().regex(/^\d{12}$/) }),
  admins: z.array(z.email()).min(1),
  email,
  stages: z.strictObject({ dev: stageOverrides.optional(), prod: stageOverrides.optional() }).optional(),
  lifetimes: z.strictObject({
    accessToken: seconds,
    refreshToken: seconds,
    siteCookie: seconds,
    sessionIdle: seconds,
    sessionMax: seconds,
    magicLink: seconds,
    uploadUrl: seconds,
  }),
  limits: z.strictObject({
    inlinePublish: bytes,
    site: bytes,
    file: bytes,
    files: z.number().int().positive(),
  }),
  // Sign-in requests allowed per email and per IP in each window (R20).
  rateLimits: z.strictObject({
    window: seconds,
    signinPerEmail: z.number().int().positive(),
    signinPerIp: z.number().int().positive(),
    // WAF on auth.: requests per IP in any five minutes, in all and to the
    // sign-in and client registration endpoints. WAF's minimum is 10.
    authPerIp: z.number().int().min(10),
    authFormsPerIp: z.number().int().min(10),
    // API Gateway throttling on mcp., for the whole endpoint.
    mcpPerSecond: z.number().int().positive(),
    mcpBurst: z.number().int().positive(),
  }),
  deleteGraceDays: z.number().int().nonnegative(),
  // How long a site's old name is held for its owner after a rename (M2 R46).
  nameHoldDays: z.number().int().nonnegative().default(7),
  // Names publishers can't use, besides the built-in ones (www, auth, ...).
  reservedNames: z.array(z.string().min(1)).default([]),
  domains: domains.default({ zones: [], namesPerTenant: 10 }),
  // How long things are kept. A site keeps every version for versionDays, then
  // the last version of each month (in timeZone) for monthEndMonths; its
  // current version is always kept. Events are kept for eventYears.
  retention: z.strictObject({
    versionDays: z.number().int().positive(),
    monthEndMonths: z.number().int().nonnegative(),
    timeZone,
    eventYears: z.number().int().positive(),
  }).default({ versionDays: 30, monthEndMonths: 24, timeZone: 'UTC', eventYears: 7 }),
  cdnAllowlist: z.array(z.string().min(1)),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}

export function loadConfigFile(path: string): Config {
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}
