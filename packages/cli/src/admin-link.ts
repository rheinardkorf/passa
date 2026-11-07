// Which admin function a deployment has, and the AWS profile that reaches it,
// remembered per server so passa admin needs neither --stage nor AWS_PROFILE
// after the first time. Admin still runs on AWS credentials, never the Passa
// sign-in (M4 R113): this only saves typing them.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { configDir } from './auth.ts';

export type AdminLink = { functionName: string; profile?: string; region?: string };
type AdminLinks = { servers: Record<string, AdminLink> };

const linksFile = (dir: string) => join(dir, 'admin.json');

export function readAdminLink(server: string, dir = configDir()): AdminLink | undefined {
  if (!existsSync(linksFile(dir))) return undefined;
  const parsed = JSON.parse(readFileSync(linksFile(dir), 'utf8')) as Partial<AdminLinks>;
  return parsed.servers?.[server];
}

export function writeAdminLink(server: string, link: AdminLink, dir = configDir()): void {
  const existing: AdminLinks = existsSync(linksFile(dir)) ? { servers: {}, ...(JSON.parse(readFileSync(linksFile(dir), 'utf8')) as Partial<AdminLinks>) } : { servers: {} };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(linksFile(dir), `${JSON.stringify({ servers: { ...existing.servers, [server]: link } }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(linksFile(dir), 0o600);
}

// The profiles in the AWS config file, and whether each signs in with SSO.
export type AwsProfile = { name: string; sso: boolean; region?: string };

export function awsProfiles(env = process.env): AwsProfile[] {
  const file = env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config');
  if (!existsSync(file)) return [];
  const profiles: AwsProfile[] = [];
  let current: AwsProfile | undefined;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    // Every [...] line starts a section; only [default] and [profile x] are profiles.
    if (line.startsWith('[')) {
      const name = line === '[default]' ? 'default' : /^\[profile\s+([^\]\s]+)\]$/.exec(line)?.[1];
      current = name ? { name, sso: false } : undefined;
      if (current) profiles.push(current);
      continue;
    }
    const setting = /^([a-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!current || !setting) continue;
    if (setting[1] === 'sso_session' || setting[1] === 'sso_start_url') current.sso = true;
    if (setting[1] === 'region' && setting[2]) current.region = setting[2];
  }
  return profiles;
}

// How to sign in again when the credentials have expired, from the profile's
// own settings: never a session or account named here.
export function signInHint(profile: string | undefined, env = process.env): string {
  const found = profile ? awsProfiles(env).find((p) => p.name === profile) : undefined;
  if (found?.sso) return `Sign in again with: aws sso login --profile ${found.name}`;
  if (profile) return `Check the credentials for AWS profile ${profile}, or pass another with --profile.`;
  return 'Sign in to the deployment\'s AWS account (such as with aws sso login), or pass --profile.';
}

// The deployment's domain, from its MCP server: https://mcp.example.com/mcp is example.com.
export function deploymentDomain(server: string): string | undefined {
  const host = new URL(server).hostname;
  return host.startsWith('mcp.') ? host.slice(4) : undefined;
}

// What finding the admin function needs from Lambda, so tests can fake it.
export type FunctionLister = {
  adminFunctions(): Promise<string[]>;
  configOf(functionName: string): Promise<string | undefined>; // its PASSA_CONFIG
};

const ADMIN_FUNCTION = /^passa-[a-z0-9-]+-admin$/;

// The admin function in the account whose config is for this domain. Several
// stages can share an account, so the domain decides, not the name.
export async function findAdminFunction(lister: FunctionLister, domain: string): Promise<string | undefined> {
  for (const name of (await lister.adminFunctions()).filter((n) => ADMIN_FUNCTION.test(n))) {
    const config = await lister.configOf(name);
    try {
      if (config && (JSON.parse(config) as { domain?: unknown }).domain === domain) return name;
    } catch {
      // not Passa's config: skip it
    }
  }
  return undefined;
}

export async function lambdaLister(options: { profile?: string; region?: string }): Promise<FunctionLister> {
  const { LambdaClient, ListFunctionsCommand, GetFunctionConfigurationCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient({ ...(options.region ? { region: options.region } : {}), ...(options.profile ? { profile: options.profile } : {}) });
  return {
    async adminFunctions() {
      const names: string[] = [];
      let Marker: string | undefined;
      do {
        const page = await client.send(new ListFunctionsCommand({ ...(Marker ? { Marker } : {}) }));
        for (const f of page.Functions ?? []) if (f.FunctionName) names.push(f.FunctionName);
        Marker = page.NextMarker;
      } while (Marker);
      return names;
    },
    async configOf(functionName) {
      const config = await client.send(new GetFunctionConfigurationCommand({ FunctionName: functionName }));
      return config.Environment?.Variables?.PASSA_CONFIG;
    },
  };
}

export class AdminTargetRefused extends Error {}

// Which admin function to invoke, and as which AWS profile:
// - --stage names the function, as before;
// - otherwise the one remembered for the server (--profile finds it again);
// - otherwise it's found by the server's domain, with the profile given,
//   $AWS_PROFILE, or the one the person picks, and remembered.
export async function adminTarget(input: {
  server?: string | undefined;
  stage?: string;
  profile?: string;
  region?: string;
  env?: NodeJS.ProcessEnv;
  dir?: string;
  pick: (question: string, choices: string[]) => Promise<string | undefined>;
  lister: (options: { profile?: string; region?: string }) => Promise<FunctionLister>;
  refusal: (err: unknown, profile: string | undefined) => Error;
}): Promise<AdminLink & { found?: boolean }> {
  const env = input.env ?? process.env;
  const stored = input.server ? readAdminLink(input.server, input.dir) : undefined;
  if (input.stage) {
    const profile = input.profile ?? stored?.profile ?? env.AWS_PROFILE;
    const region = input.region ?? stored?.region;
    return { functionName: `passa-${input.stage}-admin`, ...(profile ? { profile } : {}), ...(region ? { region } : {}) };
  }
  if (!input.server) throw new AdminTargetRefused('Which deployment? Sign in to it with passa login (or choose one with passa use), or pass --stage.');
  if (stored && !input.profile && !input.region) return stored;
  const domain = deploymentDomain(input.server);
  if (!domain) throw new AdminTargetRefused(`Can't tell ${input.server}'s deployment from its address: pass --stage.`);

  const profiles = awsProfiles(env);
  const profile = input.profile ?? env.AWS_PROFILE ?? (profiles.length ? await input.pick(`Which AWS profile reaches ${domain}'s account?`, profiles.map((p) => p.name)) : undefined);
  if (profile && profiles.length && !profiles.some((p) => p.name === profile)) {
    throw new AdminTargetRefused(`There's no AWS profile called ${profile} in your AWS config (${profiles.map((p) => p.name).join(', ')}).`);
  }
  const region = input.region ?? profiles.find((p) => p.name === (profile ?? 'default'))?.region;
  if (!region && !env.AWS_REGION && !env.AWS_DEFAULT_REGION) throw new AdminTargetRefused(`Which AWS region is ${domain} in? Pass --region, such as --region us-east-1.`);
  let functionName: string | undefined;
  try {
    functionName = await findAdminFunction(await input.lister({ ...(profile ? { profile } : {}), ...(region ? { region } : {}) }), domain);
  } catch (err) {
    throw input.refusal(err, profile);
  }
  if (!functionName) {
    throw new AdminTargetRefused(`There's no Passa admin function for ${domain} in that account${profile ? ` (AWS profile ${profile})` : ''}${region ? `, in ${region}` : ''}. Check the profile and region, or pass --stage.`);
  }
  const link: AdminLink = { functionName, ...(profile ? { profile } : {}), ...(region ? { region } : {}) };
  writeAdminLink(input.server, link, input.dir);
  return { ...link, found: true };
}
