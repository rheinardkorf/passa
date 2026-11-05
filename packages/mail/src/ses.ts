// Sends through SES (M1), through a configuration set that reports bounces and
// complaints (see auth's bounces.ts), when one is given.
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';
import type { Email, MailProvider } from '@passa/shared';

export class SesMailer implements MailProvider {
  readonly kind = 'ses';
  readonly #ses: SESv2Client;
  readonly #from: string;
  readonly #configurationSet: string | undefined;

  constructor(ses: SESv2Client, from: string, configurationSet?: string) {
    this.#ses = ses;
    this.#from = from;
    this.#configurationSet = configurationSet;
  }

  async send(email: Email): Promise<void> {
    await this.#ses.send(new SendEmailCommand({
      FromEmailAddress: this.#from,
      ...(this.#configurationSet ? { ConfigurationSetName: this.#configurationSet } : {}),
      Destination: { ToAddresses: [email.to] },
      Content: {
        Simple: {
          Subject: { Data: email.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: email.text, Charset: 'UTF-8' }, Html: { Data: email.html, Charset: 'UTF-8' } },
        },
      },
    }));
  }
}
