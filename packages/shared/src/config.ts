import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// The deployment's config, as written in config.yml (see config.example.yml).
// Every lifetime, limit and flag lives here rather than in code.
const seconds = z.number().int().positive();
const bytes = z.number().int().positive();
const domainName = z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/);
const email = z.strictObject({ from: z.string().min(1) });

export const STAGES = ['dev', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

// What a stage can change: dev usually runs on its own subdomains.
const stageOverrides = z.strictObject({
  domain: domainName.optional(),
  siteDomain: domainName.optional(),
  email: email.optional(),
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
  cdnAllowlist: z.array(z.string().min(1)),
});

export type Config = z.infer<typeof configSchema>;

// Sites are served from <site-id>.<siteDomain>, which defaults to the main
// domain. A separate domain keeps published pages off the same site as auth.
export const siteDomain = (config: Pick<Config, 'domain' | 'siteDomain'>): string => config.siteDomain ?? config.domain;

// The email sender's address and domain, from "Name <user@domain>" or "user@domain".
export const senderAddress = (from: string): string => /<([^>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
export const senderDomain = (from: string): string => /@([^>\s]+)>?$/.exec(from)?.[1] ?? from;

// The config one stage deploys with: its overrides applied, the rest as is.
export function stageConfig(config: Config, stage: Stage): Config {
  const { stages, ...base } = config;
  const overrides = stages?.[stage] ?? {};
  const result: Config = { ...base, domain: overrides.domain ?? base.domain, email: overrides.email ?? base.email };
  const sites = overrides.siteDomain ?? base.siteDomain;
  if (sites) result.siteDomain = sites;
  return result;
}

export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}

export function loadConfigFile(path: string): Config {
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}
