// The auth service's secrets, kept in Secrets Manager as one JSON document.
// cookieKeys sign oidc-provider's cookies: the first signs, all verify, so a
// new key can be added in front before an old one is dropped.
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';

export const authSecretsSchema = z.strictObject({
  cookieKeys: z.array(z.string().min(32)).min(1),
});

export type AuthSecrets = z.infer<typeof authSecretsSchema>;

export async function loadAuthSecrets(client: SecretsManagerClient, secretId: string): Promise<AuthSecrets> {
  const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return authSecretsSchema.parse(JSON.parse(SecretString ?? '{}'));
}
