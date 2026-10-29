// Builds the CloudFront Function code: handler.js plus the runtime wrapper that
// supplies the KeyValueStore handle, crypto, the time and the domains.
import { type Config, siteDomain } from '@passa/shared';
import { handlerSource } from './load.ts';

// CloudFront Functions are limited to 10 KB of code.
export const MAX_FUNCTION_BYTES = 10 * 1024;

export function functionCode(keyValueStoreId: string, config: Pick<Config, 'domain' | 'siteDomain'>): string {
  if (!/^[a-z0-9-]{1,64}$/.test(keyValueStoreId)) throw new Error('unexpected KeyValueStore ID');
  // Domains are validated by the config schema, so they are safe to embed.
  const sites = JSON.stringify(siteDomain(config));
  const auth = JSON.stringify(`https://auth.${config.domain}`);
  // Whole-line comments are dropped to save space; the source keeps them.
  const body = handlerSource().split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const code = `import cf from 'cloudfront';
const crypto = require('crypto');
const kvs = cf.kvs('${keyValueStoreId}');
${body}
async function handler(event) {
  return handle(event, { kvs: kvs, crypto: crypto, now: Date.now(), sites: ${sites}, auth: ${auth} });
}
`;
  if (Buffer.byteLength(code) > MAX_FUNCTION_BYTES) throw new Error(`function code is ${Buffer.byteLength(code)} bytes, over the CloudFront limit`);
  return code;
}
