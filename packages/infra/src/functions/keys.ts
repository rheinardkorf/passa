// Custom resource: on deploy, completes the auth secret (Secrets Manager starts
// it with a random string; later versions may add fields), keeping every valid
// key, then copies the site keys to KeyValueStore, where the edge reads them.
// Returns nothing, so no secret ever reaches CloudFormation.
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { completeAuthSecrets } from '@passa/auth/secrets';
import { KvsEdgeStore, signingKeyKey } from '@passa/shared';
import type { CloudFormationCustomResourceEvent } from 'aws-lambda';

const secrets = new SecretsManagerClient({});
const edge = new KvsEdgeStore(new CloudFrontKeyValueStoreClient({}), process.env.KVS_ARN ?? '');
const secretId = process.env.SECRET_ID ?? '';

function parseJson(value: string | undefined): unknown {
  try {
    return JSON.parse(value ?? '');
  } catch {
    return undefined;
  }
}

export async function handler(event: CloudFormationCustomResourceEvent) {
  const result = { PhysicalResourceId: 'passa-keys' };
  if (event.RequestType === 'Delete') return result;
  // A failed read throws, so keys are only ever generated for a secret that was read.
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const current = completeAuthSecrets(parseJson(SecretString), `k${Date.now().toString(36)}`);
  const updated = JSON.stringify(current);
  if (updated !== SecretString) await secrets.send(new PutSecretValueCommand({ SecretId: secretId, SecretString: updated }));
  for (const { kid, secret } of current.siteKeys) await edge.set(signingKeyKey(kid), secret);
  return result;
}
