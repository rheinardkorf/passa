// Edge records in CloudFront KeyValueStore, where the CloudFront Function
// reads them. Every write needs the store's current ETag, so a write that
// races another is retried with a fresh one.
import '@aws-sdk/signature-v4a'; // KeyValueStore requests are signed with SigV4a
import {
  type CloudFrontKeyValueStoreClient,
  DeleteKeyCommand,
  DescribeKeyValueStoreCommand,
  GetKeyCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import { type EdgeReader, type EdgeRecord, type EdgeRecords, nameKey, siteKey } from './edge.ts';

const ATTEMPTS = 5;
const errorName = (err: unknown) => (err as { name?: string }).name;

export class KvsEdgeStore implements EdgeRecords, EdgeReader {
  readonly #client: CloudFrontKeyValueStoreClient;
  readonly #arn: string;

  constructor(client: CloudFrontKeyValueStoreClient, arn: string) {
    this.#client = client;
    this.#arn = arn;
  }

  async get(key: string): Promise<string> {
    const { Value } = await this.#client.send(new GetKeyCommand({ KvsARN: this.#arn, Key: key }));
    if (Value === undefined) throw new Error('missing key');
    return Value;
  }

  set(key: string, value: string): Promise<void> {
    return this.#write((etag) => this.#client.send(new PutKeyCommand({ KvsARN: this.#arn, Key: key, Value: value, IfMatch: etag })));
  }

  put(siteId: string, record: EdgeRecord): Promise<void> {
    return this.set(siteKey(siteId), JSON.stringify(record));
  }

  remove(siteId: string): Promise<void> {
    return this.#delete(siteKey(siteId));
  }

  putName(name: string, siteId: string): Promise<void> {
    return this.set(nameKey(name), siteId);
  }

  removeName(name: string): Promise<void> {
    return this.#delete(nameKey(name));
  }

  async #delete(key: string): Promise<void> {
    try {
      await this.#write((etag) => this.#client.send(new DeleteKeyCommand({ KvsARN: this.#arn, Key: key, IfMatch: etag })));
    } catch (err) {
      if (errorName(err) !== 'ResourceNotFoundException') throw err;
    }
  }

  async #write(send: (etag: string) => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const { ETag } = await this.#client.send(new DescribeKeyValueStoreCommand({ KvsARN: this.#arn }));
      try {
        await send(ETag ?? '');
        return;
      } catch (err) {
        if (errorName(err) !== 'ConflictException' || attempt >= ATTEMPTS) throw err;
      }
    }
  }
}
