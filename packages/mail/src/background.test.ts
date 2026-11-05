import type { LambdaClient } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import { isEmail, LambdaMailer } from './background.ts';

describe('sending in the background (M5 R145)', () => {
  it('hands the message to the mail function without waiting for it', async () => {
    const sent: { input: Record<string, unknown> }[] = [];
    const lambda = { send: async (command: { input: Record<string, unknown> }) => void sent.push(command) } as unknown as LambdaClient;
    const email = { to: 'sam@example.org', subject: 'Sign in', text: 'Open it.', html: '<p>Open it.</p>' };
    await new LambdaMailer(lambda, 'passa-test-mail').send(email);
    expect(sent[0]?.input).toMatchObject({ FunctionName: 'passa-test-mail', InvocationType: 'Event' });
    expect(JSON.parse(new TextDecoder().decode(sent[0]?.input.Payload as Uint8Array))).toEqual(email);
  });

  it('takes only a complete message to one address', () => {
    const ok = { to: 'sam@example.org', subject: 's', text: 't', html: 'h' };
    expect(isEmail(ok)).toBe(true);
    for (const bad of [null, 'x', { ...ok, to: 'not an address' }, { ...ok, subject: '' }, { ...ok, bcc: 'x@example.org' }, { to: ok.to, subject: 's' }]) {
      expect(isEmail(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
