// passa admin (M4 R113–R117, M5 R143): commands over the admin's AWS
// credentials, never MCP. They invoke the deployment's admin function,
// passa-<stage>-admin: for domains, repeating a step until the domain is live
// or gone, showing progress; for users, once. The function decides everything;
// this only asks and reports.

export type DnsRecord = { name: string; type: string; value: string; purpose: 'pointer' | 'validation'; alias?: boolean };
export type DomainReport = {
  domain: string;
  site: string;
  role: 'primary' | 'alias';
  step: 'certificate' | 'attaching' | 'deploying' | 'live' | 'detaching' | 'gone';
  dns: 'route53' | 'manual';
  records: DnsRecord[];
  waiting: { record: DnsRecord; problem?: string }[];
  tenant?: string;
  problem?: string;
  warning?: string;
  primary?: boolean;
};
export type DomainList = { domains: Omit<DomainReport, 'records' | 'waiting'>[]; tenants: Record<string, number> };

// Sends one request to the admin function and returns its result.
export type Invoke = (payload: Record<string, unknown>) => Promise<unknown>;

// The admin function said no: its message is meant to be shown as it is.
export class AdminRefused extends Error {}

export const adminFunctionName = (stage: string) => `passa-${stage}-admin`;

// Invokes the function with the AWS SDK's usual credentials (AWS_PROFILE, SSO,
// environment). Loaded only for admin commands, so the rest of passa stays light.
export async function lambdaInvoker(functionName: string, region?: string): Promise<Invoke> {
  const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
  const client = new LambdaClient(region ? { region } : {});
  return async (payload) => {
    let reply;
    try {
      reply = await client.send(new InvokeCommand({ FunctionName: functionName, Payload: new TextEncoder().encode(JSON.stringify(payload)) }));
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (name === 'ResourceNotFoundException') throw new AdminRefused(`There's no ${functionName} here. Check --stage, and the region (AWS_REGION or --region).`, { cause: err });
      if (/Credential|Token|Expired|SSO/i.test(name) || /credential|token|expired/i.test(String((err as Error).message))) {
        throw new AdminRefused(`Couldn't use your AWS credentials (${(err as Error).message}). Sign in first, such as aws sso login, or set AWS_PROFILE.`, { cause: err });
      }
      if (name === 'AccessDeniedException') throw new AdminRefused(`Your AWS credentials can't invoke ${functionName}: only admins can.`, { cause: err });
      throw err;
    }
    const body = JSON.parse(new TextDecoder().decode(reply.Payload ?? new Uint8Array())) as { ok?: boolean; result?: unknown; refused?: string; errorMessage?: string };
    if (reply.FunctionError) throw new Error(`The admin function failed: ${body.errorMessage ?? 'unknown error'}. Its logs are in CloudWatch.`);
    if (body.ok === false) throw new AdminRefused(body.refused ?? 'Refused.');
    return body.result;
  };
}

export type Progress = {
  out: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  // How long one run waits before saying to run it again (it resumes).
  maxMs?: number;
  everyMs?: number;
};

const record = (r: DnsRecord) => `${r.alias ? 'ALIAS' : r.type.padEnd(5)} ${r.name.replace(/\.$/, '')}  →  ${r.value.replace(/\.$/, '')}`;

function stepLine(r: DomainReport): string {
  if (r.step === 'certificate') {
    return r.waiting.length ? `Waiting for DNS: ${r.waiting.length} record${r.waiting.length === 1 ? '' : 's'} not resolving yet` : 'Waiting for the certificate';
  }
  if (r.step === 'attaching') return 'Attaching the domain to CloudFront';
  if (r.step === 'deploying') return 'Waiting for CloudFront to deploy it';
  if (r.step === 'detaching') return 'Detaching it from CloudFront';
  return r.step;
}

// R114, R115: adds a domain and follows it until it's live.
export async function addDomain(invoke: Invoke, input: { domain: string; site: string; tenant: 'fill' | 'new'; primary?: boolean; actor?: string }, p: Progress): Promise<DomainReport> {
  const wait = p.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = p.now ?? Date.now;
  const started = now();
  let last = '';
  // Records are shown as they appear: a certificate's validation records
  // only exist once it's been requested.
  const shown = new Set<string>();
  const problems = new Set<string>();
  p.out(`Adding ${input.domain} to ${input.site} (${input.tenant === 'new' ? 'a tenant of its own' : 'filling a tenant'}).`);
  for (;;) {
    const r = await invoke({ action: 'domain.add', ...input }) as DomainReport;
    if (r.warning && !problems.has(r.warning)) {
      problems.add(r.warning);
      p.out(`  warning: ${r.warning}`);
    }
    const fresh = (r.dns === 'route53' ? r.records : r.waiting.map((w) => w.record)).filter((rec) => !shown.has(`${rec.name} ${rec.type}`));
    if (fresh.length) {
      p.out(r.dns === 'route53' ? '  DNS records, written in Route 53:' : '  Add these records at your DNS host (they can stay):');
      for (const rec of fresh) {
        shown.add(`${rec.name} ${rec.type}`);
        p.out(`    ${record(rec)}`);
      }
      if (r.dns === 'manual' && fresh.some((rec) => rec.alias)) p.out('    The apex needs an ALIAS, ANAME or flattened CNAME record; a plain CNAME isn\'t allowed there.');
    }
    for (const w of r.waiting) {
      if (w.problem && !problems.has(w.problem)) {
        problems.add(w.problem);
        p.out(`  problem: ${w.problem}`);
      }
    }
    if (r.problem && !problems.has(r.problem)) {
      problems.add(r.problem);
      p.out(`  problem: ${r.problem}`);
    }
    if (r.step === 'live') {
      p.out(`Live: https://${r.domain}/ ${r.primary ? `is now ${r.site}'s address; its other addresses redirect there.` : `redirects to ${r.site}'s primary domain.`}`);
      return r;
    }
    const line = stepLine(r);
    if (line !== last) {
      p.out(`  ${line}…`);
      last = line;
    }
    if (now() - started > (p.maxMs ?? 15 * 60_000)) {
      p.out('Still waiting. Run the same command again to carry on from here; nothing is lost.');
      return r;
    }
    await wait(p.everyMs ?? 10_000);
  }
}

// R117: removes a domain, following it until it's gone.
export async function removeDomain(invoke: Invoke, input: { domain: string; actor?: string }, p: Progress): Promise<DomainReport> {
  const wait = p.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = p.now ?? Date.now;
  const started = now();
  p.out(`Removing ${input.domain}.`);
  let last = '';
  for (;;) {
    const r = await invoke({ action: 'domain.remove', ...input }) as DomainReport;
    if (r.step === 'gone') {
      p.out(`Removed. ${r.site} is served at its other addresses again, and the records Passa wrote are gone.`);
      return r;
    }
    const line = stepLine(r);
    if (line !== last) {
      p.out(`  ${line}…`);
      last = line;
    }
    if (now() - started > (p.maxMs ?? 15 * 60_000)) {
      p.out('Still removing. Run the same command again to carry on.');
      return r;
    }
    await wait(p.everyMs ?? 10_000);
  }
}

export function formatList(list: DomainList): string[] {
  if (!list.domains.length) return ['No custom domains yet. Add one with: passa admin domain add <domain> <site> --new-tenant'];
  const rows = list.domains.map((d) => [d.domain, d.site, d.primary ? 'primary' : d.role, d.step, d.tenant ? `${d.tenant} (${list.tenants[d.tenant] ?? 0})` : '-']);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i]?.length ?? 0), ['DOMAIN', 'SITE', 'ROLE', 'STATE'][i]?.length ?? 0));
  const line = (r: string[]) => r.map((c, i) => (i < 4 ? c.padEnd(widths[i] ?? 0) : c)).join('  ');
  return [line(['DOMAIN', 'SITE', 'ROLE', 'STATE', 'TENANT (NAMES)']), ...rows.map(line)];
}

export function formatStatus(r: DomainReport): string[] {
  const lines = [`${r.domain}: ${r.step} on ${r.site} (${r.primary ? 'primary' : r.role})${r.tenant ? `, tenant ${r.tenant}` : ''}`];
  lines.push(`  DNS: ${r.dns === 'route53' ? 'written by Passa in Route 53' : 'added by you at the DNS host'}`);
  for (const rec of r.records) {
    const waiting = r.waiting.find((w) => w.record.name === rec.name && w.record.type === rec.type);
    lines.push(`    ${waiting ? '✗' : '✓'} ${record(rec)}${waiting?.problem ? `\n      ${waiting.problem}` : waiting ? '  (not resolving yet)' : ''}`);
  }
  if (r.problem) lines.push(`  problem: ${r.problem}`);
  return lines;
}

export type UserReport = { email: string; roles: string[]; status: 'active' | 'disabled'; created_at: string; in_config: boolean };

// Publishers and admins first, then people sites are shared with (no roles).
export function formatUsers(users: UserReport[]): string[] {
  if (!users.length) return ['No users yet.'];
  const role = (u: UserReport) => (u.roles.includes('admin') ? 'admin' : u.roles.includes('publisher') ? 'publisher' : 'viewer') + (u.in_config ? ' (config)' : '');
  const sorted = [...users].sort((a, b) => Number(!a.roles.length) - Number(!b.roles.length) || a.email.localeCompare(b.email));
  const rows = sorted.map((u) => [u.email, role(u), u.status, u.created_at.slice(0, 10)]);
  const widths = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i]?.length ?? 0), ['EMAIL', 'ROLE', 'STATUS'][i]?.length ?? 0));
  const line = (r: string[]) => r.map((c, i) => (i < 3 ? c.padEnd(widths[i] ?? 0) : c)).join('  ');
  return [line(['EMAIL', 'ROLE', 'STATUS', 'SINCE']), ...rows.map(line)];
}
