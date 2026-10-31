// Builds the CloudFront Functions' code: handler.js plus the runtime wrapper that
// supplies the KeyValueStore handle, crypto, the time and the domains, and
// response.js with the site domain.
import { type Config, siteDomain } from '@passa/shared';
import { handlerSource, responseSource } from './load.ts';

// CloudFront Functions are limited to 10 KB of code.
export const MAX_FUNCTION_BYTES = 10 * 1024;

// Whole-line comments are dropped to save space; the source keeps them.
const withoutComments = (source: string) => source.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

function checkSize(code: string): string {
  if (Buffer.byteLength(code) > MAX_FUNCTION_BYTES) throw new Error(`function code is ${Buffer.byteLength(code)} bytes, over the CloudFront limit`);
  return code;
}

export function functionCode(keyValueStoreId: string, config: Pick<Config, 'domain' | 'siteDomain'>): string {
  if (!/^[a-z0-9-]{1,64}$/.test(keyValueStoreId)) throw new Error('unexpected KeyValueStore ID');
  // Domains are validated by the config schema, so they are safe to embed.
  const sites = JSON.stringify(siteDomain(config));
  const auth = JSON.stringify(`https://auth.${config.domain}`);
  const code = `import cf from 'cloudfront';
const crypto = require('crypto');
const kvs = cf.kvs('${keyValueStoreId}');
${withoutComments(handlerSource())}
async function handler(event) {
  return handle(event, { kvs: kvs, crypto: crypto, now: Date.now(), sites: ${sites}, auth: ${auth} });
}
`;
  return checkSize(code);
}

// The viewer-response function, which decides x-robots-tag by host.
export function responseFunctionCode(config: Pick<Config, 'domain' | 'siteDomain'>): string {
  const sites = JSON.stringify(siteDomain(config));
  return checkSize(`${withoutComments(responseSource())}
function handler(event) {
  return robots(event, { sites: ${sites} });
}
`);
}
