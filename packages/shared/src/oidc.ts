// oidc-provider's records (grants, tokens, sessions, clients) in the passa
// table, under OIDC#<model>#<id>. GSI1 finds them by grant (to revoke a grant's
// tokens), by session UID, and a user's grants (for the connected-apps page).
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

type Payload = Record<string, unknown> & { grantId?: string; uid?: string; accountId?: string; consumed?: number };

// The storage interface oidc-provider expects for each model.
export interface OidcAdapter {
  upsert(id: string, payload: Payload, expiresIn?: number): Promise<void>;
  find(id: string): Promise<Payload | undefined>;
  findByUid(uid: string): Promise<Payload | undefined>;
  findByUserCode(userCode: string): Promise<Payload | undefined>;
  consume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  revokeByGrantId(grantId: string): Promise<void>;
}

export type GrantSummary = { id: string; clientId: string; createdAt?: string; expiresAt?: string };

const recordKey = (model: string, id: string) => ({ pk: `OIDC#${model}#${id}`, sk: 'META' });
const nowSeconds = () => Math.floor(Date.now() / 1000);
const isoFromSeconds = (seconds: number) => new Date(seconds * 1000).toISOString();

// Which GSI1 entry a record gets: tokens by their grant, sessions by UID, and
// grants by the user they belong to.
function index(model: string, id: string, payload: Payload): Record<string, string> {
  if (payload.grantId) return { gsi1pk: `OIDCGRANT#${payload.grantId}`, gsi1sk: `OIDC#${model}#${id}` };
  if (model === 'Session' && payload.uid) return { gsi1pk: `OIDCUID#${payload.uid}`, gsi1sk: 'Session' };
  if (model === 'Grant' && payload.accountId) return { gsi1pk: `OIDCACCOUNT#${payload.accountId}`, gsi1sk: `OIDC#Grant#${id}` };
  return {};
}

export class OidcStore {
  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(db: DynamoDBDocumentClient, table: string) {
    this.#db = db;
    this.#table = table;
  }

  // DynamoDB deletes expired items lazily, so expiry is checked on every read.
  #live(item: Record<string, unknown> | undefined): Payload | undefined {
    if (!item || (typeof item.ttl === 'number' && item.ttl <= nowSeconds())) return undefined;
    const payload = item.payload as Payload;
    return typeof item.consumed === 'number' ? { ...payload, consumed: item.consumed } : payload;
  }

  async #queryIndex(gsi1pk: string, prefix?: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.#db.send(new QueryCommand({
        TableName: this.#table,
        IndexName: 'gsi1',
        KeyConditionExpression: prefix ? 'gsi1pk = :pk AND begins_with(gsi1sk, :sk)' : 'gsi1pk = :pk',
        ExpressionAttributeValues: { ':pk': gsi1pk, ...(prefix ? { ':sk': prefix } : {}) },
        ExclusiveStartKey,
      }));
      items.push(...(page.Items ?? []));
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
  }

  adapter(model: string): OidcAdapter {
    const db = this.#db;
    const TableName = this.#table;
    return {
      upsert: async (id, payload, expiresIn) => {
        await db.send(new PutCommand({
          TableName,
          Item: { ...recordKey(model, id), ...index(model, id, payload), payload, ...(expiresIn ? { ttl: nowSeconds() + expiresIn } : {}) },
        }));
      },
      find: async (id) => {
        const { Item } = await db.send(new GetCommand({ TableName, Key: recordKey(model, id), ConsistentRead: true }));
        return this.#live(Item);
      },
      findByUid: async (uid) => {
        const [item] = await this.#queryIndex(`OIDCUID#${uid}`);
        return item ? this.#live(item) : undefined;
      },
      // The device flow, the only user of user codes, is off.
      findByUserCode: async () => undefined,
      consume: async (id) => {
        await db.send(new UpdateCommand({
          TableName,
          Key: recordKey(model, id),
          UpdateExpression: 'SET #consumed = :now',
          ExpressionAttributeNames: { '#consumed': 'consumed' }, // a reserved word
          ExpressionAttributeValues: { ':now': nowSeconds() },
        }));
      },
      destroy: async (id) => {
        await db.send(new DeleteCommand({ TableName, Key: recordKey(model, id) }));
      },
      revokeByGrantId: async (grantId) => {
        for (const item of await this.#queryIndex(`OIDCGRANT#${grantId}`, `OIDC#${model}#`)) {
          await db.send(new DeleteCommand({ TableName, Key: { pk: item.pk, sk: item.sk } }));
        }
      },
    };
  }

  // Whether a grant still exists. The MCP server asks on every call, so
  // revoking a grant cuts off its access tokens at once (R26).
  async grantActive(grantId: string): Promise<boolean> {
    if (!grantId) return false;
    const { Item } = await this.#db.send(new GetCommand({ TableName: this.#table, Key: recordKey('Grant', grantId), ConsistentRead: true }));
    return !!this.#live(Item);
  }

  async grantsForAccount(accountId: string): Promise<GrantSummary[]> {
    const items = await this.#queryIndex(`OIDCACCOUNT#${accountId}`, 'OIDC#Grant#');
    return items.flatMap((item) => {
      const payload = this.#live(item);
      if (!payload) return [];
      return [{
        id: String(payload.jti),
        clientId: String(payload.clientId),
        ...(typeof payload.iat === 'number' ? { createdAt: isoFromSeconds(payload.iat) } : {}),
        ...(typeof payload.exp === 'number' ? { expiresAt: isoFromSeconds(payload.exp) } : {}),
      }];
    });
  }

  // Deletes a grant and every token and code issued under it.
  async revokeGrant(grantId: string): Promise<void> {
    for (const item of await this.#queryIndex(`OIDCGRANT#${grantId}`)) {
      await this.#db.send(new DeleteCommand({ TableName: this.#table, Key: { pk: item.pk, sk: item.sk } }));
    }
    await this.#db.send(new DeleteCommand({ TableName: this.#table, Key: recordKey('Grant', grantId) }));
  }
}
