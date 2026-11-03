// DNS providers (M4 R120): Route 53 writes records in the zones config lists;
// the manual provider leaves them to a person, and either way `pending` checks
// public DNS until they resolve.
import { Resolver } from 'node:dns/promises';
import { ChangeResourceRecordSetsCommand, GetHostedZoneCommand, type Route53Client } from '@aws-sdk/client-route-53';
import { behindCloudflare, type DnsProvider, type DnsRecord } from '@passa/shared';

// CloudFront's hosted zone, for Route 53 alias records pointing at it.
const CLOUDFRONT_ZONE = 'Z2FDTNDATAQYW2';
const TTL = 300;

const bare = (name: string) => name.replace(/\.$/, '').toLowerCase();
const under = (domain: string, zone: string) => domain === zone || domain.endsWith(`.${zone}`);

export class Route53Dns implements DnsProvider {
  readonly kind = 'route53';
  readonly client: Route53Client;
  readonly zoneIds: string[];
  #zones?: Promise<{ id: string; name: string }[]>;

  constructor(client: Route53Client, zoneIds: string[]) {
    this.client = client;
    this.zoneIds = zoneIds;
  }

  #load() {
    this.#zones ??= Promise.all(this.zoneIds.map(async (id) => {
      const zone = await this.client.send(new GetHostedZoneCommand({ Id: id }));
      return { id: zone.HostedZone?.Id?.replace('/hostedzone/', '') ?? id, name: bare(zone.HostedZone?.Name ?? '') };
    }));
    return this.#zones;
  }

  // The configured zone with the longest name the domain falls under.
  async zoneFor(domain: string) {
    const zones = (await this.#load()).filter((z) => z.name && under(domain, z.name));
    return zones.sort((a, b) => b.name.length - a.name.length)[0];
  }

  upsert(records: DnsRecord[]) {
    return this.#change('UPSERT', records);
  }

  remove(records: DnsRecord[]) {
    return this.#change('DELETE', records);
  }

  async #change(action: 'UPSERT' | 'DELETE', records: DnsRecord[]) {
    const byZone = new Map<string, DnsRecord[]>();
    for (const record of records) {
      const zone = await this.zoneFor(bare(record.name));
      if (!zone) throw new Error(`${record.name} isn't in a Route 53 zone Passa manages`);
      byZone.set(zone.id, [...(byZone.get(zone.id) ?? []), record]);
    }
    for (const [zone, list] of byZone) {
      try {
        await this.client.send(new ChangeResourceRecordSetsCommand({
          HostedZoneId: zone,
          ChangeBatch: { Comment: 'Passa custom domain', Changes: list.map((r) => ({ Action: action, ResourceRecordSet: recordSet(r) })) },
        }));
      } catch (err) {
        // Deleting a record that's already gone is fine.
        if (!(action === 'DELETE' && (err as { name?: string }).name === 'InvalidChangeBatch' && /not found/i.test(String((err as Error).message)))) throw err;
      }
    }
  }
}

function recordSet(r: DnsRecord) {
  return r.alias
    ? { Name: r.name, Type: r.type, AliasTarget: { HostedZoneId: CLOUDFRONT_ZONE, DNSName: r.value, EvaluateTargetHealth: false } }
    : { Name: r.name, Type: r.type, TTL, ResourceRecords: [{ Value: r.value }] };
}

// For domains in no zone Passa manages: a person adds the records, shown to them.
export class ManualDns implements DnsProvider {
  readonly kind = 'manual';
  async zoneFor() {
    return undefined;
  }
  async upsert() {}
  async remove() {}
}

// Public resolvers, so a stale local cache never makes a record look missing.
export function publicResolver(): Resolver {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  resolver.setServers(['1.1.1.1', '8.8.8.8']);
  return resolver;
}

type Resolves = Pick<Resolver, 'resolveCname' | 'resolve4'>;

// The records that don't resolve as they should yet, and why a pointer that
// resolves somewhere else is wrong (such as a record Cloudflare proxies).
export async function pending(records: DnsRecord[], resolver: Resolves = publicResolver()): Promise<{ record: DnsRecord; problem?: string }[]> {
  const out: { record: DnsRecord; problem?: string }[] = [];
  for (const record of records) {
    const name = bare(record.name);
    if (record.type === 'CNAME') {
      const targets = await resolver.resolveCname(name).catch(() => [] as string[]);
      if (targets.map(bare).includes(bare(record.value))) continue;
      const ips = targets.length ? [] : await resolver.resolve4(name).catch(() => [] as string[]);
      out.push({ record, ...(ips.some(behindCloudflare) ? { problem: proxied(name) } : targets.length ? { problem: `${name} points at ${targets.join(', ')}, not ${record.value}` } : {}) });
    } else {
      const ips = await resolver.resolve4(name).catch(() => [] as string[]);
      if (ips.some(behindCloudflare)) out.push({ record, problem: proxied(name) });
      else if (!ips.length) out.push({ record });
    }
  }
  return out;
}

const proxied = (name: string) => `${name} resolves to Cloudflare: its record is proxied (orange cloud). Set it to DNS only (grey cloud) so it reaches Passa.`;
