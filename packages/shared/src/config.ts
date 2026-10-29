import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// The deployment's config, as written in config.yml (see config.example.yml).
// Every lifetime, limit and flag lives here rather than in code.
const seconds = z.number().int().positive();
const bytes = z.number().int().positive();
const domainName = z.string().regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/);

export const configSchema = z.strictObject({
  domain: domainName,
  siteDomain: domainName.optional(),
  region: z.string().min(1),
  accounts: z.strictObject({ dev: z.string().regex(/^\d{12}$/), prod: z.string().regex(/^\d{12}$/) }),
  admins: z.array(z.email()).min(1),
  email: z.strictObject({ from: z.string().min(1) }),
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
  }),
  deleteGraceDays: z.number().int().nonnegative(),
  cdnAllowlist: z.array(z.string().min(1)),
});

export type Config = z.infer<typeof configSchema>;

// Sites are served from <site-id>.<siteDomain>, which defaults to the main
// domain. A separate domain keeps published pages off the same site as auth.
export const siteDomain = (config: Pick<Config, 'domain' | 'siteDomain'>): string => config.siteDomain ?? config.domain;

export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}

export function loadConfigFile(path: string): Config {
  return parseConfig(parseYaml(readFileSync(path, 'utf8')));
}
