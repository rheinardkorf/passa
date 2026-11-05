// The mail interface and its providers live in @passa/shared and @passa/mail
// (M5 R140); these names stay for auth's code and tests.
export type { Email, MailProvider as Mailer } from '@passa/shared';
export { LambdaMailer, SesMailer } from '@passa/mail';
