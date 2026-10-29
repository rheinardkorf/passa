// Signs access tokens in KMS for oidc-provider, which only ever sees the
// public key. Uses oidc-provider's experimental external signing support, so
// its version is pinned and a test covers signing.
import type { KeyObject } from 'node:crypto';
import { type KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { loadTokenKey } from '@passa/shared';
import { ExternalSigningKey } from 'oidc-provider';

const P256_COORDINATE_BYTES = 32;

// KMS returns ECDSA signatures as DER (SEQUENCE { INTEGER r, INTEGER s });
// JWS wants r and s concatenated, each left-padded to 32 bytes.
export function derToJose(der: Uint8Array): Buffer {
  let offset = 2;
  const length = der[1] ?? 0;
  if (length & 0x80) offset += length & 0x7f; // long-form length, not expected for P-256
  const readInt = () => {
    if (der[offset] !== 0x02) throw new Error('bad DER signature');
    const len = der[offset + 1] ?? 0;
    let value = Buffer.from(der.subarray(offset + 2, offset + 2 + len));
    offset += 2 + len;
    while (value.length > P256_COORDINATE_BYTES && value[0] === 0) value = value.subarray(1);
    if (value.length > P256_COORDINATE_BYTES) throw new Error('bad DER signature');
    return Buffer.concat([Buffer.alloc(P256_COORDINATE_BYTES - value.length), value]);
  };
  const r = readInt();
  const s = readInt();
  return Buffer.concat([r, s]);
}

export class KmsSigningKey extends ExternalSigningKey {
  readonly #kms: KMSClient;
  readonly #keyId: string;
  readonly #publicKey: KeyObject;
  readonly #kid: string;

  private constructor(kms: KMSClient, keyId: string, kid: string, publicKey: KeyObject) {
    super();
    this.#kms = kms;
    this.#keyId = keyId;
    this.#kid = kid;
    this.#publicKey = publicKey;
  }

  override get kid(): string {
    return this.#kid;
  }

  override get alg(): string {
    return 'ES256';
  }

  static async load(kms: KMSClient, keyId: string): Promise<KmsSigningKey> {
    const { kid, publicKey } = await loadTokenKey(kms, keyId);
    return new KmsSigningKey(kms, keyId, kid, publicKey);
  }

  override keyObject(): KeyObject {
    return this.#publicKey;
  }

  override async sign(data: Uint8Array): Promise<Uint8Array> {
    const { Signature } = await this.#kms.send(new SignCommand({
      KeyId: this.#keyId,
      Message: data,
      MessageType: 'RAW',
      SigningAlgorithm: 'ECDSA_SHA_256',
    }));
    if (!Signature) throw new Error('KMS returned no signature');
    return derToJose(Signature);
  }
}
