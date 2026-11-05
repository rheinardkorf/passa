// The mail function (M5 R145): sends each message it's handed with the
// provider config chooses (R140). Invoked asynchronously by auth. and the MCP
// server; Lambda retries a failed send twice, and errors raise an alarm.
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { type MailProvider, runtimeEnv } from '@passa/shared';
import { isEmail } from './background.ts';
import { SesMailer } from './ses.ts';
import { SmtpMailer, smtpSettings } from './smtp.ts';

let provider: MailProvider | undefined;

function build(): MailProvider {
  const env = runtimeEnv();
  const { email } = env.config;
  if (email.provider === 'smtp' && email.smtp) {
    const smtp = email.smtp;
    const password = async () => {
      const r = await new SSMClient({}).send(new GetParameterCommand({ Name: smtp.passwordParameter, WithDecryption: true }));
      if (!r.Parameter?.Value) throw new Error(`${smtp.passwordParameter} is empty`);
      return r.Parameter.Value;
    };
    return new SmtpMailer(smtpSettings(smtp), email.from, password);
  }
  return new SesMailer(new SESv2Client({}), email.from, env.configurationSet);
}

export async function handler(event: unknown): Promise<void> {
  if (!isEmail(event)) throw new Error('The mail function only sends a { to, subject, text, html } message');
  provider ??= build();
  await provider.send(event);
}
