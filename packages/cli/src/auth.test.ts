import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chooseServer, type Credentials, LoginNeeded, readCredentials, type ServerCredentials, useServer, writeCredentials } from './auth.ts';
import { resolveTarget, writeLink } from './sites.ts';

const DEV = 'https://mcp.dev.example.com/mcp';
const PROD = 'https://mcp.example.com/mcp';
const saved: ServerCredentials = { issuer: 'https://auth.example.com', clientId: 'c', tokenEndpoint: 'https://auth.example.com/token', accessToken: 'a', accessExpires: 0 };
const signedIn = (credentials: Credentials) => {
  const dir = mkdtempSync(join(tmpdir(), 'passa-cli-config-'));
  writeCredentials(credentials, dir);
  return dir;
};
const both: Credentials = { current: PROD, servers: { [DEV]: saved, [PROD]: saved } };

describe('choosing a server', () => {
  it('takes --server, then PASSA_SERVER, then the current one', () => {
    expect(chooseServer('mcp.dev.example.com', both, { PASSA_SERVER: 'other.example.com' })).toBe(DEV);
    expect(chooseServer(undefined, both, { PASSA_SERVER: 'mcp.dev.example.com' })).toBe(DEV);
    expect(chooseServer(undefined, both, {})).toBe(PROD);
    expect(chooseServer(undefined, both, { PASSA_SERVER: '' })).toBe(PROD);
    expect(() => chooseServer(undefined, { servers: {} }, {})).toThrow(/passa login/);
  });

  it('keeps a linked folder on its own server, whatever PASSA_SERVER says', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'passa-cli-linked-'));
    writeLink(folder, { server: DEV, site: 'abc-def-bcdfgh' });
    const before = process.env.PASSA_SERVER;
    process.env.PASSA_SERVER = PROD;
    try {
      expect((await resolveTarget(folder)).server).toBe(DEV);
    } finally {
      if (before === undefined) delete process.env.PASSA_SERVER;
      else process.env.PASSA_SERVER = before;
    }
  });

  it('switches to a server already signed in to, and only those', () => {
    const dir = signedIn(both);
    useServer(DEV, dir);
    expect(readCredentials(dir)).toEqual({ ...both, current: DEV });
    expect(() => useServer('https://elsewhere.example.com/mcp', dir)).toThrow(LoginNeeded);
  });
});

describe('passa use', () => {
  const main = new URL('./main.ts', import.meta.url).pathname;
  const run = (dir: string, env: Record<string, string>, ...args: string[]) => {
    const rest = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'PASSA_SERVER'));
    return spawnSync(process.execPath, [main, 'use', ...args], { encoding: 'utf8', env: { ...rest, PASSA_CONFIG_DIR: dir, ...env } });
  };

  it('lists the servers signed in to, marking the current one, and switches without signing in', () => {
    const dir = signedIn(both);
    expect(run(dir, {}).stdout).toBe(`  ${DEV}\n* ${PROD}\n`);
    expect(run(dir, {}, 'mcp.dev.example.com').stdout).toBe(`Now using ${DEV}.\n`);
    expect(readCredentials(dir).current).toBe(DEV);
  });

  it('says when PASSA_SERVER overrides the choice', () => {
    const dir = signedIn(both);
    expect(run(dir, { PASSA_SERVER: 'mcp.example.com' }, 'mcp.dev.example.com').stdout).toContain(`PASSA_SERVER is set (${PROD})`);
  });

  it('refuses a server not signed in to', () => {
    const r = run(signedIn(both), {}, 'elsewhere.example.com');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('passa login https://elsewhere.example.com/mcp');
  });
});
