import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adminTarget, awsProfiles, deploymentDomain, findAdminFunction, type FunctionLister, readAdminLink, signInHint } from './admin-link.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'passa-admin-'));

// An AWS config file with an SSO profile, a key-based one, and an SSO session
// section whose settings mustn't leak into the profile before it.
function awsConfig() {
  const file = join(temp(), 'config');
  writeFileSync(file, `[default]
region = us-east-1

[profile work-prod]
sso_session = work
sso_account_id = 111111111111
region = ap-southeast-2

[profile keys]
region = eu-west-1

[sso-session work]
sso_start_url = https://example.awsapps.com/start
sso_region = ap-southeast-2
`);
  return { AWS_CONFIG_FILE: file };
}

// Two stages' admin functions in one account, and an unrelated function.
const configs: Record<string, string | undefined> = {
  'passa-dev-admin': JSON.stringify({ domain: 'dev.example.com' }),
  'passa-prod-admin': JSON.stringify({ domain: 'example.com' }),
  'billing-admin': JSON.stringify({ domain: 'example.com' }),
};
const lister: FunctionLister = { adminFunctions: async () => Object.keys(configs), configOf: async (name) => configs[name] };

describe('the AWS config file', () => {
  it('lists profiles, which sign in with SSO, and their regions', () => {
    expect(awsProfiles(awsConfig())).toEqual([
      { name: 'default', sso: false, region: 'us-east-1' },
      { name: 'work-prod', sso: true, region: 'ap-southeast-2' },
      { name: 'keys', sso: false, region: 'eu-west-1' },
    ]);
    expect(awsProfiles({ AWS_CONFIG_FILE: join(temp(), 'missing') })).toEqual([]);
  });

  it('says how to sign in again from the profile\'s own settings', () => {
    expect(signInHint('work-prod', awsConfig())).toBe('Sign in again with: aws sso login --profile work-prod');
    expect(signInHint('keys', awsConfig())).toContain('Check the credentials for AWS profile keys');
    expect(signInHint(undefined, awsConfig())).toContain('or pass --profile');
  });
});

describe('finding the admin function', () => {
  it('matches the deployment\'s domain, not just the name', async () => {
    expect(deploymentDomain('https://mcp.example.com/mcp')).toBe('example.com');
    expect(deploymentDomain('http://localhost:8080/mcp')).toBeUndefined();
    expect(await findAdminFunction(lister, 'example.com')).toBe('passa-prod-admin');
    expect(await findAdminFunction(lister, 'dev.example.com')).toBe('passa-dev-admin');
    expect(await findAdminFunction(lister, 'other.example')).toBeUndefined();
  });
});

describe('which admin function, as which profile', () => {
  const server = 'https://mcp.example.com/mcp';
  const base = (dir: string, over: Partial<Parameters<typeof adminTarget>[0]> = {}) => adminTarget({
    server, dir, env: awsConfig(), lister: async () => lister, refusal: (err) => err as Error,
    pick: async () => { throw new Error('should not ask'); }, ...over,
  });

  it('asks for a profile the first time, finds the function, and remembers both', async () => {
    const dir = temp();
    const asked: string[][] = [];
    const first = await base(dir, { pick: async (_q, choices) => (asked.push(choices), 'work-prod') });
    expect(asked).toEqual([['default', 'work-prod', 'keys']]);
    expect(first).toEqual({ functionName: 'passa-prod-admin', profile: 'work-prod', region: 'ap-southeast-2', found: true });
    expect(readAdminLink(server, dir)).toEqual({ functionName: 'passa-prod-admin', profile: 'work-prod', region: 'ap-southeast-2' });
    expect(statSync(join(dir, 'admin.json')).mode & 0o777).toBe(0o600);
    // Next time: no question, no lookup.
    expect(await base(dir, { lister: async () => { throw new Error('should not look'); } })).toEqual({ functionName: 'passa-prod-admin', profile: 'work-prod', region: 'ap-southeast-2' });
  });

  it('takes $AWS_PROFILE or --profile without asking, and --profile finds it again', async () => {
    const dir = temp();
    expect(await base(dir, { env: { ...awsConfig(), AWS_PROFILE: 'keys' } })).toMatchObject({ profile: 'keys', region: 'eu-west-1' });
    expect(await base(dir, { profile: 'work-prod' })).toMatchObject({ profile: 'work-prod', found: true });
    expect(readAdminLink(server, dir)?.profile).toBe('work-prod');
  });

  it('uses --stage as given, and refuses when it can\'t tell the deployment', async () => {
    expect(await base(temp(), { server: undefined, stage: 'dev', profile: 'keys' })).toEqual({ functionName: 'passa-dev-admin', profile: 'keys' });
    await expect(base(temp(), { server: undefined })).rejects.toThrow(/passa login .* or pass --stage/);
    await expect(base(temp(), { server: 'https://mcp.other.example/mcp', profile: 'keys' })).rejects.toThrow('no Passa admin function for other.example in that account (AWS profile keys), in eu-west-1');
  });

  it('refuses a profile the AWS config doesn\'t have, and asks for a region it can\'t tell', async () => {
    await expect(base(temp(), { profile: 'nope' })).rejects.toThrow('There\'s no AWS profile called nope in your AWS config (default, work-prod, keys).');
    await expect(base(temp(), { env: { AWS_CONFIG_FILE: join(temp(), 'missing') } })).rejects.toThrow('Pass --region');
  });

  it('turns AWS errors into the given refusal, with the profile', async () => {
    const lost = Object.assign(new Error('Token is expired'), { name: 'TokenProviderError' });
    await expect(base(temp(), { profile: 'work-prod', lister: async () => { throw lost; }, refusal: (_e, p) => new Error(`refused for ${p}`) })).rejects.toThrow('refused for work-prod');
  });
});
