// Email Passa sends (M5 R140): one shape and one interface, whichever provider
// sends it. SES and SMTP implement it (@passa/mail), and so does the hand-off
// to the mail function, which sends in the background (R145).
export type Email = { to: string; subject: string; text: string; html: string };

export interface MailProvider {
  // ses, smtp, or how a message is handed on (lambda, memory in tests).
  readonly kind: string;
  send(email: Email): Promise<void>;
}
