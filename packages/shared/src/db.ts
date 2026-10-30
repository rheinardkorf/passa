// The one module that reads and writes the passa table. Every read is a get or
// a key-condition query; scans belong in standalone maintenance jobs only.
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Rule } from './rules.ts';

export type Role = 'admin' | 'publisher';

export type User = {
  id: string;
  email: string;
  roles: Role[];
  status: 'active' | 'disabled';
  createdAt: string;
};

export type Site = {
  id: string;
  ownerId: string;
  title: string;
  dataSource?: string;
  dataAsOf?: string;
  current: string;
  // Bumped whenever who may view the site changes, so older cookies stop working.
  accessVersion: number;
  // blocked: a file failed a malware scan, so the site isn't served.
  status: 'active' | 'deleting' | 'blocked';
  // Path rules (M2). None means the whole site is private.
  rules?: Rule[];
  purgeAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type FileEntry = { path: string; size: number; contentType: string; sha256: string };

export type Version = {
  id: string;
  siteId: string;
  files: FileEntry[];
  size: number;
  createdAt: string;
  createdBy: string;
};

export type UploadFile = { path: string; size: number };

export type Upload = {
  id: string;
  ownerId: string;
  files: UploadFile[];
  status: 'pending' | 'ready' | 'used';
  createdAt: string;
  expiresAt: string;
};

// A magic link, stored under the hash of its token (R16). siteId and path, or
// an OAuth interaction, say where to go after sign-in.
export type SignInToken = {
  userId: string;
  siteId?: string;
  path?: string;
  interaction?: string;
  createdAt: string;
  expiresAt: string;
};

// An auth. session, stored under the hash of its ID (R18).
export type Session = {
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string; // the maximum lifetime; idle expiry is checked from lastSeenAt
};

// Thrown when a conditional write fails: the item is missing, belongs to
// someone else, or is in the wrong state. Callers report it as "not found".
export class NotFoundOrConflict extends Error {}

const userKey = (id: string) => ({ pk: `USER#${id}`, sk: 'PROFILE' });
const siteKey = (id: string) => ({ pk: `SITE#${id}`, sk: 'META' });
const versionKey = (siteId: string, id: string) => ({ pk: `SITE#${siteId}`, sk: `VER#${id}` });
const uploadKey = (id: string) => ({ pk: `UPLOAD#${id}`, sk: 'META' });
const purgeKey = (siteId: string) => ({ pk: `PURGE#${siteId}`, sk: 'META' });
const tokenKey = (hash: string) => ({ pk: `TOKEN#${hash}`, sk: 'META' });
const sessionKey = (hash: string) => ({ pk: `SESSION#${hash}`, sk: 'META' });
const rateKey = (name: string, windowStart: number) => ({ pk: `RATE#${name}`, sk: `W#${windowStart}` });

const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const KEY_ATTRIBUTES = new Set(['pk', 'sk', 'gsi1pk', 'gsi1sk', 'ttl']);

// Strips the key attributes so callers only see the entity.
function strip<T>(item: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(item).filter(([name]) => !KEY_ATTRIBUTES.has(name))) as T;
}

function entity<T>(item: Record<string, unknown> | undefined): T | undefined {
  return item ? strip<T>(item) : undefined;
}

function isConditionFailure(err: unknown) {
  return err instanceof ConditionalCheckFailedException || err instanceof TransactionCanceledException;
}

export class Store {
  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(db: DynamoDBDocumentClient, table: string) {
    this.#db = db;
    this.#table = table;
  }

  async getUser(id: string): Promise<User | undefined> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: userKey(id), ConsistentRead: true }));
    return entity<User>(Item);
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const { Items } = await this.#db.send(new QueryCommand({
      TableName: this.#table,
      IndexName: 'gsi1',
      KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk = :sk',
      ExpressionAttributeValues: { ':pk': `EMAIL#${email.toLowerCase()}`, ':sk': 'USER' },
      Limit: 1,
    }));
    return entity<User>(Items?.[0]);
  }

  async putUser(user: User): Promise<void> {
    await this.#db.send(new PutCommand({
      TableName: this.#table,
      Item: { ...userKey(user.id), gsi1pk: `EMAIL#${user.email.toLowerCase()}`, gsi1sk: 'USER', ...user },
    }));
  }

  async getSite(id: string): Promise<Site | undefined> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: siteKey(id), ConsistentRead: true }));
    return entity<Site>(Item);
  }

  async listSitesByOwner(ownerId: string): Promise<Site[]> {
    const sites: Site[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#db.send(new QueryCommand({
        TableName: this.#table,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :pk AND begins_with(gsi1sk, :sk)',
        ExpressionAttributeValues: { ':pk': `OWNER#${ownerId}`, ':sk': 'SITE#' },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }));
      for (const item of page.Items ?? []) sites.push(strip<Site>(item));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return sites;
  }

  // Writes a new site and its first version together.
  async createSite(site: Site, version: Version): Promise<void> {
    await this.#db.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: this.#table,
            Item: { ...siteKey(site.id), gsi1pk: `OWNER#${site.ownerId}`, gsi1sk: `SITE#${site.createdAt}`, ...site },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Put: {
            TableName: this.#table,
            Item: { ...versionKey(site.id, version.id), ...version },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
      ],
    }));
  }

  // Adds a version and makes it current, if the site is the owner's, active,
  // and still on the version this one was built from.
  async addVersion(ownerId: string, version: Version, baseVersionId: string): Promise<void> {
    try {
      await this.#db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.#table,
              Item: { ...versionKey(version.siteId, version.id), ...version },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Update: {
              TableName: this.#table,
              Key: siteKey(version.siteId),
              UpdateExpression: 'SET #current = :v, updatedAt = :now',
              ConditionExpression: 'ownerId = :owner AND #status = :active AND #current = :base',
              ExpressionAttributeNames: { '#current': 'current', '#status': 'status' },
              ExpressionAttributeValues: { ':v': version.id, ':now': version.createdAt, ':owner': ownerId, ':active': 'active', ':base': baseVersionId },
            },
          },
        ],
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  async getVersion(siteId: string, id: string): Promise<Version | undefined> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: versionKey(siteId, id), ConsistentRead: true }));
    return entity<Version>(Item);
  }

  async listVersions(siteId: string): Promise<Version[]> {
    const versions: Version[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#db.send(new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': `SITE#${siteId}`, ':sk': 'VER#' },
        ScanIndexForward: false,
        ExclusiveStartKey,
      }));
      for (const item of page.Items ?? []) versions.push(strip<Version>(item));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return versions;
  }

  // One page of versions, newest first, starting after the version given. next
  // is the last version returned, and only set when more follow.
  async listVersionsPage(siteId: string, page: { limit: number; after?: string }): Promise<{ versions: Version[]; next?: string }> {
    const versions: Version[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined = page.after ? versionKey(siteId, page.after) : undefined;
    // Reads one more than asked for, to know whether another page follows.
    do {
      const result = await this.#db.send(new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: { ':pk': `SITE#${siteId}`, ':sk': 'VER#' },
        ScanIndexForward: false,
        Limit: page.limit + 1 - versions.length,
        ExclusiveStartKey,
      }));
      for (const item of result.Items ?? []) versions.push(strip<Version>(item));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey && versions.length <= page.limit);
    const shown = versions.slice(0, page.limit);
    const last = shown.at(-1);
    return last && versions.length > page.limit ? { versions: shown, next: last.id } : { versions: shown };
  }

  // Makes an existing version current again (rollback).
  async setCurrentVersion(ownerId: string, siteId: string, versionId: string, now: string): Promise<void> {
    try {
      await this.#db.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.#table,
              Key: versionKey(siteId, versionId),
              ConditionExpression: 'attribute_exists(pk)',
            },
          },
          {
            Update: {
              TableName: this.#table,
              Key: siteKey(siteId),
              UpdateExpression: 'SET #current = :v, updatedAt = :now',
              ConditionExpression: 'ownerId = :owner AND #status = :active',
              ExpressionAttributeNames: { '#current': 'current', '#status': 'status' },
              ExpressionAttributeValues: { ':v': versionId, ':now': now, ':owner': ownerId, ':active': 'active' },
            },
          },
        ],
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  // Stops an active site being served after a malware finding. Returns false
  // if the site doesn't exist or isn't active (already blocked or deleting).
  async blockSite(siteId: string, now: string): Promise<boolean> {
    try {
      await this.#db.send(new UpdateCommand({
        TableName: this.#table,
        Key: siteKey(siteId),
        UpdateExpression: 'SET #status = :blocked, updatedAt = :now',
        ConditionExpression: '#status = :active',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':blocked': 'blocked', ':active': 'active', ':now': now },
      }));
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  // Starts the grace period. The PURGE item's TTL fires the hard delete.
  // Blocked sites can be deleted too.
  async markDeleting(ownerId: string, siteId: string, purgeAt: string, now: string): Promise<void> {
    try {
      await this.#db.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.#table,
              Key: siteKey(siteId),
              UpdateExpression: 'SET #status = :deleting, purgeAt = :purgeAt, updatedAt = :now',
              ConditionExpression: 'ownerId = :owner AND #status IN (:active, :blocked)',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: { ':deleting': 'deleting', ':purgeAt': purgeAt, ':now': now, ':owner': ownerId, ':active': 'active', ':blocked': 'blocked' },
            },
          },
          {
            Put: {
              TableName: this.#table,
              Item: { ...purgeKey(siteId), siteId, ttl: epochSeconds(purgeAt) },
            },
          },
        ],
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  // Removes every record of a site: META, all versions and any PURGE marker.
  async deleteSiteRecords(siteId: string): Promise<void> {
    const keys: Record<string, string>[] = [purgeKey(siteId)];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#db.send(new QueryCommand({
        TableName: this.#table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `SITE#${siteId}` },
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey,
      }));
      for (const item of page.Items ?? []) keys.push({ pk: String(item.pk), sk: String(item.sk) });
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    for (let i = 0; i < keys.length; i += 25) {
      let requests = keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } }));
      while (requests.length) {
        const { UnprocessedItems } = await this.#db.send(new BatchWriteCommand({ RequestItems: { [this.#table]: requests } }));
        requests = (UnprocessedItems?.[this.#table] ?? []) as typeof requests;
      }
    }
  }

  async putUpload(upload: Upload): Promise<void> {
    await this.#db.send(new PutCommand({
      TableName: this.#table,
      Item: { ...uploadKey(upload.id), ...upload, ttl: epochSeconds(upload.expiresAt) },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  // DynamoDB deletes expired items lazily, so expiry is checked here too.
  async getUpload(id: string, now: string): Promise<Upload | undefined> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: uploadKey(id), ConsistentRead: true }));
    const upload = entity<Upload>(Item);
    return upload && upload.expiresAt > now ? upload : undefined;
  }

  async markUploadReady(ownerId: string, id: string): Promise<void> {
    try {
      await this.#db.send(new UpdateCommand({
        TableName: this.#table,
        Key: uploadKey(id),
        UpdateExpression: 'SET #status = :ready',
        ConditionExpression: 'ownerId = :owner AND #status = :pending',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':ready': 'ready', ':pending': 'pending', ':owner': ownerId },
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  // Claims a ready upload for one publish or update, so it can't be used twice.
  async markUploadUsed(ownerId: string, id: string): Promise<void> {
    try {
      await this.#db.send(new UpdateCommand({
        TableName: this.#table,
        Key: uploadKey(id),
        UpdateExpression: 'REMOVE files SET #status = :used',
        ConditionExpression: 'ownerId = :owner AND #status = :ready',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':used': 'used', ':ready': 'ready', ':owner': ownerId },
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  async putSignInToken(hash: string, token: SignInToken): Promise<void> {
    await this.#db.send(new PutCommand({
      TableName: this.#table,
      Item: { ...tokenKey(hash), ...token, ttl: epochSeconds(token.expiresAt) },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  // Deletes the token and returns it if it was still valid, so each link
  // works at most once even when two requests race.
  async takeSignInToken(hash: string, now: string): Promise<SignInToken | undefined> {
    const { Attributes } = await this.#db.send(new DeleteCommand({ TableName: this.#table, Key: tokenKey(hash), ReturnValues: 'ALL_OLD' }));
    const token = entity<SignInToken>(Attributes);
    return token && token.expiresAt > now ? token : undefined;
  }

  // ttl is when DynamoDB may remove it: the earlier of idle and maximum expiry.
  async putSession(hash: string, session: Session, ttl: number): Promise<void> {
    await this.#db.send(new PutCommand({
      TableName: this.#table,
      Item: { ...sessionKey(hash), ...session, ttl },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }

  async getSession(hash: string): Promise<Session | undefined> {
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: sessionKey(hash), ConsistentRead: true }));
    return entity<Session>(Item);
  }

  async touchSession(hash: string, lastSeenAt: string, ttl: number): Promise<void> {
    try {
      await this.#db.send(new UpdateCommand({
        TableName: this.#table,
        Key: sessionKey(hash),
        UpdateExpression: 'SET lastSeenAt = :now, #ttl = :ttl',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':now': lastSeenAt, ':ttl': ttl },
      }));
    } catch (err) {
      if (isConditionFailure(err)) throw new NotFoundOrConflict();
      throw err;
    }
  }

  async deleteSession(hash: string): Promise<void> {
    await this.#db.send(new DeleteCommand({ TableName: this.#table, Key: sessionKey(hash) }));
  }

  // Counts one request against a fixed window and returns the count so far.
  async countRequest(name: string, windowStart: number, windowSeconds: number): Promise<number> {
    const { Attributes } = await this.#db.send(new UpdateCommand({
      TableName: this.#table,
      Key: rateKey(name, windowStart),
      UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':ttl': windowStart + windowSeconds },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(Attributes?.count ?? 0);
  }
}
