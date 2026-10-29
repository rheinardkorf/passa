// Edge records: the compact copy of each site that the CloudFront Function
// reads from KeyValueStore, since it can't reach DynamoDB. DynamoDB stays the
// source of truth; records are rewritten whenever a site changes.
import { DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Site } from './db.ts';

// cur: current version. v: access version (cookies must match it). r: path rules, empty (private) in M1.
export type EdgeRecord = { cur: string; v: number; r: unknown[] };

export const siteKey = (siteId: string) => `s:${siteId}`;
export const signingKeyKey = (kid: string) => `k:${kid}`;

// Only active sites are served; a site being deleted has no record.
export function edgeRecord(site: Site): EdgeRecord | undefined {
  return site.status === 'active' ? { cur: site.current, v: site.accessVersion, r: [] } : undefined;
}

export interface EdgeRecords {
  put(siteId: string, record: EdgeRecord): Promise<void>;
  remove(siteId: string): Promise<void>;
}

// Writes the record for a site's current state, or removes it.
export async function syncEdge(edge: EdgeRecords, site: Site): Promise<void> {
  const record = edgeRecord(site);
  await (record ? edge.put(site.id, record) : edge.remove(site.id));
}

// Reads like the CloudFront KeyValueStore handle: get() throws when a key is missing.
export interface EdgeReader {
  get(key: string): Promise<string>;
}

// A KeyValueStore stand-in on a DynamoDB table, for local development and
// tests, where there's no KeyValueStore to write to.
export class TableEdgeStore implements EdgeRecords, EdgeReader {
  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(db: DynamoDBDocumentClient, table: string) {
    this.#db = db;
    this.#table = table;
  }

  async get(key: string): Promise<string> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: { key } }));
    if (!Item) throw new Error('missing key');
    return String(Item.value);
  }

  async set(key: string, value: string): Promise<void> {
    await this.#db.send(new PutCommand({ TableName: this.#table, Item: { key, value } }));
  }

  put(siteId: string, record: EdgeRecord): Promise<void> {
    return this.set(siteKey(siteId), JSON.stringify(record));
  }

  async remove(siteId: string): Promise<void> {
    await this.#db.send(new DeleteCommand({ TableName: this.#table, Key: { key: siteKey(siteId) } }));
  }
}

export class MemoryEdgeStore implements EdgeRecords, EdgeReader {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string> {
    const value = this.values.get(key);
    if (value === undefined) throw new Error('missing key');
    return value;
  }

  async put(siteId: string, record: EdgeRecord): Promise<void> {
    this.values.set(siteKey(siteId), JSON.stringify(record));
  }

  async remove(siteId: string): Promise<void> {
    this.values.delete(siteKey(siteId));
  }
}
