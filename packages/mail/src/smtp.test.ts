import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer, smtpSettings } from './smtp.ts';

// A fake SMTP server over real TLS, with a throwaway self-signed certificate:
// enough of the protocol for one message, recording what it was told.
type Received = { auth: string[]; from: string; to: string[]; data: string };
let server: Server;
let port: number;
const received: Received[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'passa-smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  server = createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) }, (socket) => {
    const r: Received = { auth: [], from: '', to: [], data: '' };
    let buffer = '';
    let inData = false;
    socket.write('220 fake.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(r);
            socket.write('250 queued\r\n');
          } else r.data += `${line}\n`;
          continue;
        }
        const verb = line.split(' ')[0]?.toUpperCase();
        if (verb === 'EHLO') socket.write('250-fake.test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (verb === 'AUTH') {
          r.auth.push(Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8'));
          socket.write('235 ok\r\n');
        } else if (verb === 'MAIL') {
          r.from = line;
          socket.write('250 ok\r\n');
        } else if (verb === 'RCPT') {
          r.to.push(line);
          socket.write('250 ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('the SMTP provider (M5 R141)', () => {
  it('sends over TLS, signing in with the password it fetches once', async () => {
    let fetched = 0;
    const mailer = new SmtpMailer({ host: '127.0.0.1', port, user: 'passa@example.com', tls: 'implicit' }, 'Passa <passa@example.com>', async () => {
      fetched++;
      return 'app-password';
    }, { tls: { rejectUnauthorized: false } });
    await mailer.send({ to: 'sam@example.org', subject: 'Sign in to Passa', text: 'Open the link.', html: '<p>Open the link.</p>' });
    await mailer.send({ to: 'alex@example.org', subject: 'Again', text: 'Again.', html: '<p>Again.</p>' });
    expect(fetched).toBe(1);
    const [first] = received;
    expect(first?.auth[0]).toBe('\0passa@example.com\0app-password');
    expect(first?.from).toContain('<passa@example.com>');
    expect(first?.to).toEqual(['RCPT TO:<sam@example.org>']);
    expect(first?.data).toMatch(/^Subject: Sign in to Passa$/m);
    expect(first?.data).toContain('Open the link.');
    expect(received[1]?.to).toEqual(['RCPT TO:<alex@example.org>']);
  });

  it('refuses a server whose certificate it can\'t trust', async () => {
    const strict = new SmtpMailer({ host: '127.0.0.1', port, user: 'u', tls: 'implicit' }, 'u@example.com', async () => 'p');
    await expect(strict.send({ to: 'sam@example.org', subject: 's', text: 't', html: 'h' })).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it('tries the password again after it failed to fetch', async () => {
    let calls = 0;
    const mailer = new SmtpMailer({ host: '127.0.0.1', port, user: 'u', tls: 'implicit' }, 'u@example.com', async () => {
      calls++;
      if (calls === 1) throw new Error('parameter store unavailable');
      return 'p';
    }, { tls: { rejectUnauthorized: false } });
    await expect(mailer.send({ to: 'sam@example.org', subject: 's', text: 't', html: 'h' })).rejects.toThrow('parameter store unavailable');
    await mailer.send({ to: 'sam@example.org', subject: 's', text: 't', html: 'h' });
    expect(calls).toBe(2);
  });

  it('uses TLS for 465 and requires STARTTLS on 587, never plain text', () => {
    expect(smtpSettings({ host: 'smtp.example.com', port: 465, user: 'u' }).tls).toBe('implicit');
    expect(smtpSettings({ host: 'smtp.example.com', port: 587, user: 'u' }).tls).toBe('starttls');
  });
});
