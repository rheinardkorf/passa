// The deployment's config (see config.example.yml): its type and helpers.
// The schema and file loader are in config-file.ts, so functions that only
// read config don't bundle zod and yaml.
import type { Config } from './config-file.ts';

export type { Config };

export const STAGES = ['dev', 'prod'] as const;
export type Stage = (typeof STAGES)[number];

// Sites are served from <site-id>.<siteDomain>, which defaults to the main
// domain. A separate domain keeps published pages off the same site as auth.
export const siteDomain = (config: Pick<Config, 'domain' | 'siteDomain'>): string => config.siteDomain ?? config.domain;

// The email sender's address and domain, from "Name <user@domain>" or "user@domain".
// Plain string operations, so no input can make them slow.
export function senderAddress(from: string): string {
  const open = from.lastIndexOf('<');
  const close = from.lastIndexOf('>');
  return (open >= 0 && close > open ? from.slice(open + 1, close) : from).trim();
}

export function senderDomain(from: string): string {
  const address = senderAddress(from);
  return address.slice(address.lastIndexOf('@') + 1);
}

// The config one stage deploys with: its overrides applied, the rest as is.
export function stageConfig(config: Config, stage: Stage): Config {
  const { stages, ...base } = config;
  const overrides = stages?.[stage] ?? {};
  const result: Config = { ...base, domain: overrides.domain ?? base.domain, email: overrides.email ?? base.email, domains: overrides.domains ?? base.domains, waf: overrides.waf ?? base.waf };
  const sites = overrides.siteDomain ?? base.siteDomain;
  if (sites) result.siteDomain = sites;
  return result;
}
