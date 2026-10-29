// The access-token signing key lives in KMS: auth. signs with it, and the MCP
// server checks signatures with its public half. The private key never leaves KMS.
import { createPublicKey, type KeyObject } from 'node:crypto';
import { GetPublicKeyCommand, type KMSClient } from '@aws-sdk/client-kms';

export type TokenKey = { kid: string; publicKey: KeyObject };

export async function loadTokenKey(kms: KMSClient, keyId: string): Promise<TokenKey> {
  const { KeyId, PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!PublicKey) throw new Error('KMS returned no public key');
  const publicKey = createPublicKey({ key: Buffer.from(PublicKey), format: 'der', type: 'spki' });
  // Checked from the key itself: tokens are ES256, so it must be P-256.
  if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('the token signing key must be an ECC_NIST_P256 key');
  }
  // The key's ARN ends in its ID; either way the kid is stable and not secret.
  return { kid: (KeyId ?? keyId).split('/').pop() ?? keyId, publicKey };
}
