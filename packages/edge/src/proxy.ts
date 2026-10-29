// The local edge: an HTTP server that runs the real edge handler on each
// request, then serves the rewritten path from the sites bucket with the same
// headers CloudFront adds. Sites are at http://<site-id>.localhost:<port>.
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { type EdgeReader, siteHeaders } from '@passa/shared';
import { type EdgeRequest, type Header, isResponse, loadHandler } from './load.ts';

export type ProxyOptions = {
  edge: EdgeReader;
  s3: S3Client;
  bucket: string;
  cdnAllowlist: string[];
  now?: () => number;
};

// Query values are passed on undecoded, the stricter of the ways CloudFront may
// present them; the handler decodes what it needs.
function toEvent(req: IncomingMessage): { request: EdgeRequest } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  const querystring: Record<string, Header> = {};
  for (const pair of (q === -1 ? '' : raw.slice(q + 1)).split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    querystring[eq === -1 ? pair : pair.slice(0, eq)] = { value: eq === -1 ? '' : pair.slice(eq + 1) };
  }
  const headers: Record<string, Header> = {};
  for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[name] = { value };
  const cookies: Record<string, Header> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = { value: part.slice(eq + 1).trim() };
  }
  return { request: { method: req.method ?? 'GET', uri: q === -1 ? raw : raw.slice(0, q), querystring, headers, cookies } };
}

export function startProxy(options: ProxyOptions, port: number): Promise<Server> {
  const handle = loadHandler();
  const crypto = { createHmac: (algorithm: string, key: string) => createHmac(algorithm, key) };
  const headers = siteHeaders({ cdnAllowlist: options.cdnAllowlist });

  async function serve(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    // Locally, sites are <site-id>.localhost:<port> and auth. is auth.localhost:<port>.
    const address = server.address();
    const sites = `localhost:${typeof address === 'object' && address ? address.port : port}`;
    const result = await handle(toEvent(req), { kvs: options.edge, crypto, now: (options.now ?? Date.now)(), sites, auth: `http://auth.${sites}` });
    if (isResponse(result)) {
      for (const [name, { value }] of Object.entries(result.headers)) res.setHeader(name, value);
      const cookies = Object.entries(result.cookies ?? {}).map(([name, c]) => `${name}=${c.value}; ${c.attributes}`);
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.writeHead(result.statusCode).end(req.method === 'HEAD' ? undefined : result.body?.data);
      return;
    }
    try {
      const object = await options.s3.send(new GetObjectCommand({ Bucket: options.bucket, Key: result.uri.slice(1) }));
      const etag = object.ETag ?? '';
      res.setHeader('content-type', object.ContentType ?? 'application/octet-stream');
      if (etag) res.setHeader('etag', etag);
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      if (etag && req.headers['if-none-match'] === etag) {
        res.writeHead(304).end();
        return;
      }
      const body = await object.Body?.transformToByteArray();
      res.writeHead(200, { 'content-length': String(body?.byteLength ?? 0) }).end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      if ((err as { name?: string }).name !== 'NoSuchKey') throw err;
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Not found');
    }
  }

  const server = createServer((req, res) => {
    serve(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502).end('Proxy error');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
