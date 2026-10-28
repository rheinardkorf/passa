// The append-only events table: publishing actions and security events (R31).
// Items are only ever put, never updated or deleted by application code.
import { randomBytes } from 'node:crypto';
import { type DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export type Event = {
  action: string;
  result: 'ok' | 'refused' | 'error';
  userId?: string;
  email?: string;
  ip?: string;
  siteId?: string;
  detail?: string;
};

export class Events {
  readonly #db: DynamoDBDocumentClient;
  readonly #table: string;

  constructor(db: DynamoDBDocumentClient, table: string) {
    this.#db = db;
    this.#table = table;
  }

  async record(event: Event, at: Date = new Date()): Promise<void> {
    const iso = at.toISOString();
    await this.#db.send(new PutCommand({
      TableName: this.#table,
      Item: { pk: `DAY#${iso.slice(0, 10)}`, sk: `${iso}#${randomBytes(6).toString('hex')}`, at: iso, ...event },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  }
}
