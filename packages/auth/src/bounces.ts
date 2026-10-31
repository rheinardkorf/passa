// SES bounce and complaint events, delivered through SNS. A permanent bounce
// or a complaint disables the user, so Passa stops emailing that address; SES
// also adds it to the account's suppression list. Admins aren't disabled, so a
// single complaint can't lock a deployment's owners out; the event is still
// recorded and the SES alarms still fire.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Events, runtimeEnv, Store } from '@passa/shared';
import type { SNSEvent } from 'aws-lambda';

type SesEvent = {
  eventType?: string;
  bounce?: { bounceType?: string; bouncedRecipients?: { emailAddress?: string }[] };
  complaint?: { complainedRecipients?: { emailAddress?: string }[] };
};

export type BounceDeps = { store: Store; events: Events };

// The addresses that should get no more email, and why.
export function undeliverable(event: SesEvent): { email: string; reason: 'bounce' | 'complaint' }[] {
  const addresses = (list: { emailAddress?: string }[] | undefined) => (list ?? []).flatMap((r) => (r.emailAddress ? [r.emailAddress] : []));
  if (event.eventType === 'Bounce' && event.bounce?.bounceType === 'Permanent') return addresses(event.bounce.bouncedRecipients).map((email) => ({ email, reason: 'bounce' }));
  if (event.eventType === 'Complaint') return addresses(event.complaint?.complainedRecipients).map((email) => ({ email, reason: 'complaint' }));
  return [];
}

export async function handleSesEvent(deps: BounceDeps, event: SesEvent): Promise<void> {
  for (const { email, reason } of undeliverable(event)) {
    // Addresses arrive as sent; users are stored lower-case.
    const user = await deps.store.findUserByEmail(email.trim().toLowerCase());
    const admin = !!user?.roles.includes('admin');
    if (user && !admin && user.status === 'active') await deps.store.putUser({ ...user, status: 'disabled' });
    await deps.events.record({
      action: `email.${reason}`,
      result: 'ok',
      email,
      ...(user ? { userId: user.id } : {}),
      detail: !user ? 'no such user' : admin ? 'admin kept active' : 'user disabled',
    });
  }
}

let deps: BounceDeps | undefined;

export async function handler(event: SNSEvent): Promise<void> {
  if (!deps) {
    const env = runtimeEnv();
    const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    deps = { store: new Store(db, env.tables.main), events: new Events(db, env.tables.events, env.config.retention.eventYears) };
  }
  for (const record of event.Records) await handleSesEvent(deps, JSON.parse(record.Sns.Message) as SesEvent);
}
