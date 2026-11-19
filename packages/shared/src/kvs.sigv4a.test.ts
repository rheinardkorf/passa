import { CloudFrontKeyValueStoreClient, GetKeyCommand } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { describe, expect, it } from 'vitest';
import './kvs.ts'; // loads the SigV4a signer, as Passa does

// KeyValueStore requests are signed with SigV4a, which the SDK finds only if
// @aws-sdk/signature-v4a registered with the same copy of @smithy/signature-v4
// the SDK uses. Two copies in the lockfile broke every edge write in
// production ("Neither CRT nor JS SigV4a implementation is available") while
// the tests, with a fake client, passed. This signs a real request, and stops
// it before it's sent.
describe('KeyValueStore signing', () => {
  it('signs requests with SigV4a', async () => {
    const client = new CloudFrontKeyValueStoreClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example' },
    });
    let authorization: string | undefined;
    client.middlewareStack.add(() => async (args) => {
      authorization = (args.request as { headers: Record<string, string> }).headers.authorization;
      throw new Error('stop before sending');
    }, { step: 'finalizeRequest', priority: 'low', name: 'captureSignature' });
    const arn = 'arn:aws:cloudfront::123456789012:key-value-store/00000000-0000-0000-0000-000000000000';
    await expect(client.send(new GetKeyCommand({ KvsARN: arn, Key: 'n:example' }))).rejects.toThrow('stop before sending');
    expect(authorization).toMatch(/^AWS4-ECDSA-P256-SHA256 /);
  });
});
