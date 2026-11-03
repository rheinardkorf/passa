// HTTP for the CLI: node:http(s), so a *.localhost name connects to 127.0.0.1
// with its own Host header, as browsers do, and the local stack works as is.
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type Reply = { status: number; headers: IncomingHttpHeaders; body: Buffer };
export type Request = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array };

export function request(url: string, init: Request = {}): Promise<Reply> {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost');
  const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send({
      host: local ? '127.0.0.1' : u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { host: u.host, ...init.headers, ...(init.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body)) }) },
      ...(local || u.protocol !== 'https:' ? {} : { servername: u.hostname }),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(60_000, () => req.destroy(new Error(`${u.host} didn't answer in time`)));
    req.on('error', reject);
    req.end(init.body);
  });
}

export const json = (reply: Reply): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(reply.body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const form = (fields: Record<string, string>) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams(fields).toString(),
});
