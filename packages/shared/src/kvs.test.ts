import type { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { describe, expect, it } from 'vitest';
import { KvsEdgeStore } from './kvs.ts';

// A fake KeyValueStore: writes must carry the current ETag, which every write changes.
function fakeKvs(options: { conflicts?: number } = {}) {
  const values = new Map<string, string>();
  let etag = 1;
  let conflicts = options.conflicts ?? 0;
  const calls: string[] = [];
  const fail = (name: string) => Object.assign(new Error(name), { name });
  const client = {
    async send(command: { constructor: { name: string }; input: Record<string, string> }) {
      const { input } = command;
      const name = command.constructor.name;
      calls.push(name);
      if (name === 'DescribeKeyValueStoreCommand') return { ETag: String(etag) };
      if (name === 'GetKeyCommand') {
        if (!values.has(input.Key ?? '')) throw fail('ResourceNotFoundException');
        return { Value: values.get(input.Key ?? '') };
      }
      if (conflicts > 0) {
        conflicts--;
        etag++;
        throw fail('ConflictException');
      }
      if (input.IfMatch !== String(etag)) throw fail('ConflictException');
      etag++;
      if (name === 'PutKeyCommand') values.set(input.Key ?? '', input.Value ?? '');
      else if (!values.delete(input.Key ?? '')) throw fail('ResourceNotFoundException');
      return { ETag: String(etag) };
    },
  };
  return { values, calls, store: new KvsEdgeStore(client as unknown as CloudFrontKeyValueStoreClient, 'arn:aws:cloudfront::000000000000:key-value-store/test') };
}

describe('KvsEdgeStore', () => {
  it('writes and removes site records', async () => {
    const { store, values } = fakeKvs();
    await store.put('abc', { cur: 'v1', v: 1, r: [] });
    expect(JSON.parse(await store.get('s:abc'))).toEqual({ cur: 'v1', v: 1, r: [] });
    await store.remove('abc');
    expect(values.size).toBe(0);
  });

  it('retries a write that raced another', async () => {
    const { store, calls } = fakeKvs({ conflicts: 2 });
    await store.set('k:one', 'secret');
    expect(calls.filter((c) => c === 'PutKeyCommand')).toHaveLength(3);
    expect(await store.get('k:one')).toBe('secret');
  });

  it('gives up after repeated conflicts', async () => {
    const { store } = fakeKvs({ conflicts: 10 });
    await expect(store.set('k:one', 'secret')).rejects.toThrow('ConflictException');
  });

  it('treats removing a missing record as done', async () => {
    await expect(fakeKvs().store.remove('gone')).resolves.toBeUndefined();
  });
});
