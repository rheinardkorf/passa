// Test wiring for the auth app against Moto: a KMS token key, the OIDC store,
// and a mailer that keeps what it sends.
import { randomBytes } from 'node:crypto';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import type { TestEnv } from '@passa/mcp/testing';
import { OidcStore } from '@passa/shared';
import type { AuthDeps } from './app.ts';
import { KmsSigningKey } from './kms-key.ts';
import type { Email, Mailer } from './mailer.ts';
import type { Urls } from './signin.ts';

const endpoint = process.env.PASSA_TEST_AWS_ENDPOINT ?? 'http://127.0.0.1:5005';
export const testKms = () => new KMSClient({ endpoint, region: 'ap-southeast-2', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });

export async function createTokenKey(kms: KMSClient): Promise<string> {
  const { KeyMetadata } = await kms.send(new CreateKeyCommand({ KeySpec: 'ECC_NIST_P256', KeyUsage: 'SIGN_VERIFY' }));
  if (!KeyMetadata?.KeyId) throw new Error('no key created');
  return KeyMetadata.KeyId;
}

export type AuthTestDeps = AuthDeps & { sent: Email[]; tokenKeyId: string; kms: KMSClient };

export async function authTestDeps(env: TestEnv, urls: Urls, extra: { mailer?: Mailer; now?: () => Date } = {}): Promise<AuthTestDeps> {
  const kms = testKms();
  const tokenKeyId = await createTokenKey(kms);
  const sent: Email[] = [];
  const mailer = extra.mailer;
  // The site cookie key, shared with the edge; tests may have set one already.
  await env.edge.get('k:k1').catch(() => env.edge.set('k:k1', randomBytes(32).toString('hex')));
  return {
    ...env,
    kms,
    tokenKeyId,
    sent,
    mailer: {
      async send(email) {
        await mailer?.send(email);
        sent.push(email);
      },
    },
    siteKey: async () => ({ kid: 'k1', secret: await env.edge.get('k:k1') }),
    oidc: new OidcStore(env.db, env.tables.main),
    tokenSigner: await KmsSigningKey.load(kms, tokenKeyId),
    cookieKeys: [randomBytes(32).toString('base64url')],
    urls,
    ...(extra.now ? { now: extra.now } : {}),
  };
}
