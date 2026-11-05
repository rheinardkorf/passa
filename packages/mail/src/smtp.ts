// Sends through any SMTP service (M5 R141): TLS on 465, or STARTTLS required
// on 587. The password is fetched when first needed (from Parameter Store, on
// AWS) and kept for the life of the function. Bounces are left to the
// service's own suppression. Some services send only as the account's own
// address (Gmail rewrites any other From).
import type { Email, MailProvider } from '@passa/shared';
import nodemailer, { type Transporter } from 'nodemailer';

// tls: implicit (port 465) or a required STARTTLS (587): never plain text.
export type SmtpSettings = { host: string; port: number; user: string; tls: 'implicit' | 'starttls' };

// The settings for a configured port.
export const smtpSettings = (s: { host: string; port: 465 | 587; user: string }): SmtpSettings => ({ ...s, tls: s.port === 465 ? 'implicit' : 'starttls' });

export class SmtpMailer implements MailProvider {
  readonly kind = 'smtp';
  readonly #settings: SmtpSettings;
  readonly #from: string;
  readonly #password: () => Promise<string>;
  readonly #tls: { rejectUnauthorized: boolean } | undefined;
  #transport: Promise<Transporter> | undefined;

  constructor(settings: SmtpSettings, from: string, password: () => Promise<string>, options: { tls?: { rejectUnauthorized: boolean } } = {}) {
    this.#settings = settings;
    this.#from = from;
    this.#password = password;
    this.#tls = options.tls;
  }

  #connect() {
    this.#transport ??= this.#password().then((pass) => nodemailer.createTransport({
      host: this.#settings.host,
      port: this.#settings.port,
      secure: this.#settings.tls === 'implicit',
      requireTLS: this.#settings.tls === 'starttls',
      auth: { user: this.#settings.user, pass },
      ...(this.#tls ? { tls: this.#tls } : {}),
    })).catch((err: unknown) => {
      this.#transport = undefined; // try again on the next message
      throw err;
    });
    return this.#transport;
  }

  async send(email: Email): Promise<void> {
    const transport = await this.#connect();
    await transport.sendMail({ from: this.#from, to: email.to, subject: email.subject, text: email.text, html: email.html });
  }
}
