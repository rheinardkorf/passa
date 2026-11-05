// Hands each message to the mail function without waiting for it to be sent
// (M5 R145), so sign-in answers in the same short time whichever provider
// sends, and a slow SMTP service (2-3 s a message) never delays it.
import { InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { Email, MailProvider } from '@passa/shared';

export class LambdaMailer implements MailProvider {
  readonly kind = 'lambda';
  readonly #lambda: LambdaClient;
  readonly #functionName: string;

  constructor(lambda: LambdaClient, functionName: string) {
    this.#lambda = lambda;
    this.#functionName = functionName;
  }

  async send(email: Email): Promise<void> {
    await this.#lambda.send(new InvokeCommand({ FunctionName: this.#functionName, InvocationType: 'Event', Payload: new TextEncoder().encode(JSON.stringify(email)) }));
  }
}

// What the mail function accepts: exactly an Email, nothing else.
export function isEmail(value: unknown): value is Email {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return Object.keys(e).length === 4 && ['to', 'subject', 'text', 'html'].every((k) => typeof e[k] === 'string' && (e[k] as string).length > 0)
    && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(e.to as string);
}
