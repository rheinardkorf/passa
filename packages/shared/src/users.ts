// Users from config (R30): every admin email gets a user record, with a stable
// ID that sites are owned by. Existing users keep their ID and status.
import { newUserId } from './ids.ts';
import type { Store, User } from './db.ts';

export async function bootstrapAdmins(store: Store, emails: string[], now: Date = new Date()): Promise<User[]> {
  const users: User[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    const existing = await store.findUserByEmail(email);
    if (existing) {
      const roles = [...new Set([...existing.roles, 'admin', 'publisher'] as const)];
      if (roles.length !== existing.roles.length) await store.putUser({ ...existing, roles });
      users.push({ ...existing, roles });
      continue;
    }
    const user: User = { id: newUserId(), email, roles: ['admin', 'publisher'], status: 'active', createdAt: now.toISOString() };
    await store.putUser(user);
    users.push(user);
  }
  return users;
}
