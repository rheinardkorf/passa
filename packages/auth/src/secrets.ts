// The auth service's secrets, kept in Secrets Manager as one JSON document.
// cookieKeys sign oidc-provider's cookies: the first signs, all verify, so a
// new key can be added in front before an old one is dropped. siteKeys sign
// site handoffs and cookies; the edge reads them from KeyValueStore by kid,
// where they're copied on deploy. The first signs. originVerify is the header
// CloudFront adds, so the function URL only answers CloudFront.
import { randomBytes } from 'node:crypto';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

const cookieKeys = z.array(z.string().min(32)).min(1);
const siteKeys = z.array(z.strictObject({ kid: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), secret: z.string().min(32) })).min(1);
const originVerify = z.string().min(32);

export const authSecretsSchema = z.strictObject({ cookieKeys, siteKeys, originVerify });

export type AuthSecrets = z.infer<typeof authSecretsSchema>;

// Keeps every valid part of existing secrets and generates the rest, so adding
// a field never replaces keys already in use.
export function completeAuthSecrets(existing: unknown, kid: string): AuthSecrets {
  const have = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>;
  return {
    cookieKeys: cookieKeys.safeParse(have.cookieKeys).data ?? [randomBytes(32).toString('base64url')],
    siteKeys: siteKeys.safeParse(have.siteKeys).data ?? [{ kid, secret: randomBytes(32).toString('hex') }],
    originVerify: originVerify.safeParse(have.originVerify).data ?? randomBytes(32).toString('base64url'),
  };
}

export const newAuthSecrets = (kid: string): AuthSecrets => completeAuthSecrets(undefined, kid);

export async function loadAuthSecrets(client: SecretsManagerClient, secretId: string): Promise<AuthSecrets> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return authSecretsSchema.parse(JSON.parse(SecretString ?? '{}'));
}
