// Builds the CloudFront Functions' code: handler.js plus the runtime wrapper that
// supplies the KeyValueStore handle, crypto, the time and the domains, and
// response.js with the site domain.
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { type Config, siteDomain } from '@passa/shared';
import { handlerSource, responseSource } from './load.ts';

// CloudFront Functions are limited to 10 KB of code.
export const MAX_FUNCTION_BYTES = 10 * 1024;

// Passa's copy of HTMX (M7 R173), which infra uploads beside the sites, and
// the path the handler serves it at (the bucket key, without its /).
export const htmxFile = () => createRequire(import.meta.url).resolve('htmx.org/dist/htmx.min.js');
export function htmxPath(): string {
  const path = /^const HTMX = '([^']+)';$/m.exec(handlerSource())?.[1];
  if (!path) throw new Error('handler.js names no HTMX path');
  return path;
}

// Minified to fit (M7: 7.7 KB of code became 4.5). Minifying a module renames
// its top-level functions, so the entry point is exported to learn its new
// name, then called from a function with the name the runtime looks for.
// esbuild only shortens and drops: it adds no syntax beyond the source's.
export function minify(code: string, entry: string): string {
  const out = transformSync(`${code}\nexport { ${entry} };`, { minify: true, format: 'esm', target: 'es2017', legalComments: 'none' }).code;
  const exported = new RegExp(`export\\s*\\{\\s*([\\w$]+) as ${entry}\\s*\\};?\\s*$`).exec(out);
  if (!exported) throw new Error(`minifying lost ${entry}`);
  return `${out.slice(0, exported.index)}function ${entry}(a,b){return ${exported[1]}(a,b)}\n`;
}

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
${handlerSource()}
async function handler(event) {
  return handle(event, { kvs: kvs, crypto: crypto, now: Date.now(), sites: ${sites}, auth: ${auth} });
}
`;
  return checkSize(minify(code, 'handler'));
}

// The viewer-response function, which decides x-robots-tag and cross-origin-resource-policy.
export function responseFunctionCode(config: Pick<Config, 'domain' | 'siteDomain'>): string {
  const sites = JSON.stringify(siteDomain(config));
  return checkSize(minify(`${responseSource()}
function handler(event) {
  return viewerResponse(event, { sites: ${sites} });
}
`, 'handler'));
}
