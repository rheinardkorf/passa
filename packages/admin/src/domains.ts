// What passa admin domain does (M4 R113–R117), run by the admin function one
// step per call: the CLI calls again until a domain is live or gone, showing
// progress. Providers do the AWS work; this keeps the domain's record, writes
// or reports its DNS records, and switches the site once the domain serves.
import type { Publisher } from '@passa/mcp';
import {
  type Attachment, checkDomain, type Config, type DnsProvider, type DnsRecord, type Domain, type DomainProvider, DomainTaken,
  type Events, isSiteId, type Site, siteDomain, type Store, type TenantChoice,
} from '@passa/shared';
import { pending } from './dns.ts';

export type DomainDeps = {
  store: Store;
  events: Events;
  config: Config;
  publisher: Pick<Publisher, 'setDomains'>;
  provider: DomainProvider;
  // Route 53 for the zones config lists; manual for everything else.
  dns: DnsProvider;
  manual: DnsProvider;
  // Public DNS, replaceable in tests.
  pending?: typeof pending;
  now?: () => Date;
};

// What a step reports to the CLI.
export type DomainReport = {
  domain: string;
  site: string;
  role: Domain['role'];
  step: Domain['step'];
  // dns: who writes the records. waiting: the records not resolving yet, and why.
  dns: DnsProvider['kind'];
  records: DnsRecord[];
  waiting: { record: DnsRecord; problem?: string }[];
  tenant?: string;
  problem?: string;
  warning?: string;
  primary?: boolean;
};

export class DomainRefused extends Error {}

export class AdminDomains {
  readonly #d: DomainDeps;

  constructor(deps: DomainDeps) {
    this.#d = deps;
  }

  #now() {
    return (this.#d.now ?? (() => new Date()))().toISOString();
  }

  // R114, R115: claims the domain on the first call, then moves it one step.
  async add(input: { domain: string; site: string; tenant: TenantChoice; primary?: boolean; actor?: string }): Promise<DomainReport> {
    const { store } = this.#d;
    const domain = input.domain.trim().toLowerCase();
    const checked = checkDomain(domain, { domain: this.#d.config.domain, siteDomain: siteDomain(this.#d.config) });
    if (checked.problem) throw new DomainRefused(checked.problem);
    const site = await this.#site(input.site);
    let item: Domain | undefined = await store.getDomain(domain);
    if (item && item.siteId !== site.id) throw new DomainRefused(`${domain} is attached to another site (${item.siteId}). Remove it there first.`);
    if (!item) {
      const now = this.#now();
      // The site's first domain is its primary; later ones are aliases.
      const others = (await store.listDomains()).filter((d) => d.siteId === site.id);
      const role: Domain['role'] = input.primary || !others.some((d) => d.role === 'primary') ? 'primary' : 'alias';
      item = { domain, siteId: site.id, role, step: 'certificate', records: [], wrote: [], createdAt: now, updatedAt: now };
      try {
        await store.claimDomain(item);
      } catch (err) {
        if (err instanceof DomainTaken) throw new DomainRefused(`${domain} is already attached to a site.`, { cause: err });
        throw err;
      }
      await this.#record('admin.domain.add', site.id, `${domain} (${role}, ${input.tenant} tenant)${input.actor ? ` by ${input.actor}` : ''}`);
    }

    const dns = (await this.#d.dns.zoneFor(domain)) ? this.#d.dns : this.#d.manual;
    const zone = await this.#d.dns.zoneFor(domain);
    // An apex has no CNAME. In a Route 53 zone that's the zone's own name;
    // elsewhere a two-label name (example.com) is taken to be one.
    const apex = zone ? zone.name === domain : domain.split('.').length === 2;
    const claimed: Domain = item;
    const attachment = claimed.step === 'live' ? claimed : await this.#d.provider.attach(domain, { tenant: input.tenant, apex }, claimed);
    const toWrite = attachment.records.filter((r) => !claimed.wrote.some((w) => w.name === r.name && w.type === r.type));
    if (dns.kind === 'route53' && toWrite.length) await dns.upsert(toWrite);
    item = { ...claimed, ...attachment, wrote: dns.kind === 'route53' ? [...claimed.wrote, ...toWrite] : claimed.wrote, updatedAt: this.#now() };
    if (input.primary && item.role !== 'primary') item.role = 'primary';
    await store.saveDomain(item);

    // Live: the site switches to it (R115), and a new primary renders again (R124).
    if (item.step === 'live') await this.#serve(site, item);
    const waiting = item.step === 'certificate' ? await (this.#d.pending ?? pending)(item.records) : [];
    // Reported as things are now, after any switch.
    const now = (await store.getSite(site.id)) ?? site;
    return this.#report((await store.getDomain(domain)) ?? item, now, dns.kind, waiting, checked.warning);
  }

  // R117: the site moves off the domain first, then it's detached and its
  // records removed. Call again until the step is gone.
  async remove(input: { domain: string; actor?: string }): Promise<DomainReport> {
    const { store } = this.#d;
    const item = await store.getDomain(input.domain);
    if (!item) throw new DomainRefused(`${input.domain} isn't attached to any site.`);
    const site = await store.getSite(item.siteId);
    if (site?.domains?.includes(item.domain)) {
      const rest = site.domains.filter((d) => d !== item.domain);
      // Removing the primary promotes the next domain, else the name or ID.
      const primary = site.domain === item.domain ? rest[0] : site.domain;
      if (site.status !== 'deleting') await this.#d.publisher.setDomains(site.id, rest, primary);
      if (primary && primary !== site.domain) await this.#setRole(primary, 'primary');
    }
    const next: Attachment = await this.#d.provider.detach(item);
    if (next.step !== 'gone') {
      const saved = { ...item, ...next, updatedAt: this.#now() };
      await store.saveDomain(saved);
      return this.#report(saved, site, 'route53', []);
    }
    if (item.wrote.length) await this.#d.dns.remove(item.wrote);
    await store.deleteDomain(item.domain, item.siteId);
    await this.#record('admin.domain.remove', item.siteId, `${item.domain}${input.actor ? ` by ${input.actor}` : ''}`);
    return this.#report({ ...item, step: 'gone' }, site, 'route53', []);
  }

  // R116: every domain, with its site, role, state and tenant.
  async list(): Promise<{ domains: (Omit<DomainReport, 'records' | 'waiting'>)[]; tenants: Record<string, number> }> {
    const all = await this.#d.store.listDomains();
    const tenants: Record<string, number> = {};
    for (const d of all) if (d.tenant) tenants[d.tenant] = (tenants[d.tenant] ?? 0) + 1;
    const sites = new Map<string, Site | undefined>();
    for (const d of all) if (!sites.has(d.siteId)) sites.set(d.siteId, await this.#d.store.getSite(d.siteId));
    return {
      domains: all.map((d) => {
        const report: Partial<DomainReport> = this.#report(d, sites.get(d.siteId), d.wrote.length ? 'route53' : 'manual', []);
        delete report.records;
        delete report.waiting;
        return report as Omit<DomainReport, 'records' | 'waiting'>;
      }),
      tenants,
    };
  }

  // R116: a domain's state, with its records checked against public DNS.
  async status(domain: string): Promise<DomainReport> {
    const item = await this.#d.store.getDomain(domain);
    if (!item) throw new DomainRefused(`${domain} isn't attached to any site.`);
    const site = await this.#d.store.getSite(item.siteId);
    const zone = await this.#d.dns.zoneFor(domain);
    return this.#report(item, site, zone ? 'route53' : 'manual', await (this.#d.pending ?? pending)(item.records));
  }

  async #serve(site: Site, item: Domain) {
    const current = (await this.#d.store.getSite(site.id)) ?? site;
    const domains = current.domains ?? [];
    const wantPrimary = item.role === 'primary' && current.domain !== item.domain;
    if (domains.includes(item.domain) && !wantPrimary) return;
    const next = domains.includes(item.domain) ? domains : [...domains, item.domain];
    const primary = wantPrimary || !current.domain ? item.domain : current.domain;
    await this.#d.publisher.setDomains(site.id, next, primary);
    // The domain that was primary is now an alias.
    if (current.domain && primary !== current.domain) await this.#setRole(current.domain, 'alias');
  }

  async #setRole(domain: string, role: Domain['role']) {
    const item = await this.#d.store.getDomain(domain);
    if (item && item.role !== role) await this.#d.store.saveDomain({ ...item, role, updatedAt: this.#now() });
  }

  async #site(label: string): Promise<Site> {
    const id = isSiteId(label) ? label : (await this.#d.store.getName(label))?.siteId;
    const site = id ? await this.#d.store.getSite(id) : undefined;
    if (!site || (!isSiteId(label) && site.name !== label)) throw new DomainRefused(`No site ${label}.`);
    if (site.status !== 'active') throw new DomainRefused(`${label} is ${site.status}, so it can't take a domain.`);
    return site;
  }

  #report(item: Domain, site: Site | undefined, dns: DnsProvider['kind'], waiting: DomainReport['waiting'], warning?: string): DomainReport {
    return {
      domain: item.domain,
      site: site?.name ?? item.siteId,
      role: item.role,
      step: item.step,
      dns,
      records: item.records,
      waiting,
      ...(item.tenant ? { tenant: item.tenant } : {}),
      ...(item.problem ? { problem: item.problem } : {}),
      ...(warning ? { warning } : {}),
      ...(site?.domain === item.domain ? { primary: true } : {}),
    };
  }

  #record(action: string, siteId: string, detail: string) {
    return this.#d.events.record({ action, result: 'ok', userId: 'admin', siteId, detail });
  }
}
