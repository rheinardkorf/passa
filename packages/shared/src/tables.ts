// Table shapes, shared by local setup and the CDK stacks so they can't drift.
import { CreateTableCommand, type CreateTableCommandInput, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

export const mainTable = (TableName: string): CreateTableCommandInput => ({
  TableName,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
    { AttributeName: 'gsi1pk', AttributeType: 'S' },
    { AttributeName: 'gsi1sk', AttributeType: 'S' },
    { AttributeName: 'gsi2pk', AttributeType: 'S' },
    { AttributeName: 'gsi2sk', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
  GlobalSecondaryIndexes: [
    {
      // SITE# lists an owner's sites, SHARE# their shares by end (M6 R165).
      IndexName: 'gsi1',
      KeySchema: [
        { AttributeName: 'gsi1pk', KeyType: 'HASH' },
        { AttributeName: 'gsi1sk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
    // Overloaded and sparse: only items that set gsi2pk are in it. USERS lists
    // every user by email (M5 R143); TIER#<site>#<tier> a tier's members (M6 R155).
    {
      IndexName: 'gsi2',
      KeySchema: [
        { AttributeName: 'gsi2pk', KeyType: 'HASH' },
        { AttributeName: 'gsi2sk', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    },
  ],
});

export const eventsTable = (TableName: string): CreateTableCommandInput => ({
  TableName,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [
    { AttributeName: 'pk', AttributeType: 'S' },
    { AttributeName: 'sk', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'pk', KeyType: 'HASH' },
    { AttributeName: 'sk', KeyType: 'RANGE' },
  ],
});

// Local stand-in for the edge KeyValueStore (see TableEdgeStore).
export const edgeTable = (TableName: string): CreateTableCommandInput => ({
  TableName,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: [{ AttributeName: 'key', AttributeType: 'S' }],
  KeySchema: [{ AttributeName: 'key', KeyType: 'HASH' }],
});

export async function createTables(client: DynamoDBClient, names: { main: string; events: string; edge?: string }): Promise<void> {
  const inputs = [mainTable(names.main), eventsTable(names.events), ...(names.edge ? [edgeTable(names.edge)] : [])];
  for (const input of inputs) {
    try {
      await client.send(new CreateTableCommand(input));
    } catch (err) {
      if ((err as { name?: string }).name !== 'ResourceInUseException') throw err;
    }
  }
}
