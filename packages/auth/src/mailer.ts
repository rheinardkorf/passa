// Sends the one kind of email Passa sends in M1: magic links, through SES.
import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';

export type Email = { to: string; subject: string; text: string; html: string };

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class SesMailer implements Mailer {
  readonly #ses: SESv2Client;
  readonly #from: string;

  constructor(ses: SESv2Client, from: string) {
    this.#ses = ses;
    this.#from = from;
  }

  async send(email: Email): Promise<void> {
    await this.#ses.send(new SendEmailCommand({
      FromEmailAddress: this.#from,
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
