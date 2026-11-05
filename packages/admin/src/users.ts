// passa admin users (M5 R143): who can publish. Admins add publishers and
// disable or enable them. Admins listed in config stay admins, and the last
// active admin can't be disabled, so a deployment always has someone to run it.
// Disabling takes effect on the user's next MCP call (R8) and sign-in.
import { type Config, type Events, newUserId, type Role, type Store, type User } from '@passa/shared';

export class UserRefused extends Error {}

export type UserReport = { email: string; roles: Role[]; status: User['status']; created_at: string; in_config: boolean };

export type AdminUsersDeps = { store: Store; events: Events; config: Config; now?: () => Date };

export class AdminUsers {
  readonly #d: AdminUsersDeps;

  constructor(deps: AdminUsersDeps) {
    this.#d = deps;
  }

  #report(user: User): UserReport {
    return { email: user.email, roles: user.roles, status: user.status, created_at: user.createdAt, in_config: this.#inConfig(user.email) };
  }

  #inConfig(email: string) {
    return this.#d.config.admins.some((a) => a.trim().toLowerCase() === email);
  }

  async #record(action: string, user: User, actor: string | undefined) {
    await this.#d.events.record({ action, result: 'ok', userId: user.id, email: user.email, ...(actor ? { detail: `by ${actor}` } : {}) });
  }

  async #find(raw: string): Promise<User> {
    const user = await this.#d.store.findUserByEmail(raw.trim().toLowerCase());
    if (!user) throw new UserRefused(`There's no user with the email ${raw.trim().toLowerCase()}.`);
    return user;
  }

  // Everyone with a user record: publishers, admins, and people sites are
  // shared with (no roles), who can only view.
  async list(): Promise<UserReport[]> {
    try {
      return (await this.#d.store.listUsers()).map((u) => this.#report(u));
    } catch (err) {
      // Right after an upgrade, DynamoDB is still building the users index.
      if (/backfilling global secondary index/i.test(String((err as Error).message))) {
        throw new UserRefused('The users index is still being built after the upgrade. Try again in a few minutes.', { cause: err });
      }
      throw err;
    }
  }

  // Makes an email a publisher (and an admin with admin: true). Someone a
  // site was shared with keeps their record and gains the roles.
  async add(input: { email: string; admin?: boolean; actor?: string }): Promise<UserReport> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new UserRefused(`${email} isn't an email address.`);
    const wanted: Role[] = input.admin ? ['admin', 'publisher'] : ['publisher'];
    const existing = await this.#d.store.findUserByEmail(email);
    if (existing) {
      const roles = [...new Set([...existing.roles, ...wanted])].sort() as Role[];
      if (roles.length === existing.roles.length) throw new UserRefused(`${email} is already ${existing.roles.includes('admin') ? 'an admin' : 'a publisher'}${existing.status === 'disabled' ? ', but disabled: enable them instead' : ''}.`);
      const user = { ...existing, roles };
      await this.#d.store.putUser(user);
      await this.#record('admin.user.add', user, input.actor);
      return this.#report(user);
    }
    const user: User = { id: newUserId(), email, roles: wanted, status: 'active', createdAt: (this.#d.now?.() ?? new Date()).toISOString() };
    await this.#d.store.putUser(user);
    await this.#record('admin.user.add', user, input.actor);
    return this.#report(user);
  }

  // Adds users written before the users index to it (a one-off; see Store.reindexUsers).
  async reindex(): Promise<{ reindexed: number }> {
    return { reindexed: await this.#d.store.reindexUsers() };
  }

  async disable(input: { email: string; actor?: string }): Promise<UserReport> {
    const user = await this.#find(input.email);
    if (this.#inConfig(user.email)) throw new UserRefused(`${user.email} is an admin in config, and stays one: take it out of admins there and deploy first.`);
    if (user.status === 'disabled') return this.#report(user);
    if (user.roles.includes('admin')) {
      const others = (await this.#d.store.listUsers()).filter((u) => u.id !== user.id && u.status === 'active' && u.roles.includes('admin'));
      if (!others.length) throw new UserRefused(`${user.email} is the last active admin, so can't be disabled.`);
    }
    const disabled: User = { ...user, status: 'disabled' };
    await this.#d.store.putUser(disabled);
    await this.#record('admin.user.disable', disabled, input.actor);
    return this.#report(disabled);
  }

  async enable(input: { email: string; actor?: string }): Promise<UserReport> {
    const user = await this.#find(input.email);
    if (user.status === 'active') return this.#report(user);
    const enabled: User = { ...user, status: 'active' };
    await this.#d.store.putUser(enabled);
    await this.#record('admin.user.enable', enabled, input.actor);
    return this.#report(enabled);
  }
}
