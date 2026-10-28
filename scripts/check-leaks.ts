// Fails if a file in the repo contains something that identifies a real
// deployment or a credential: AWS account IDs, access keys, private keys, or
// any value listed in .leaks.local (one per line, never committed; put your
// own domain and account IDs there).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const SKIP = new Set(['pnpm-lock.yaml', '.leaks.local']);
const PLACEHOLDER_ACCOUNTS = new Set(['000000000000', '111111111111', '123456789012']);

const patterns: { name: string; regex: RegExp; allow?: (match: string) => boolean }[] = [
  { name: 'AWS account ID', regex: /(?<![\d.])\d{12}(?![\d.])/g, allow: (m) => PLACEHOLDER_ACCOUNTS.has(m) },
  { name: 'AWS access key ID', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

if (existsSync('.leaks.local')) {
  for (const line of readFileSync('.leaks.local', 'utf8').split('\n')) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    patterns.push({ name: 'value from .leaks.local', regex: new RegExp(escaped, 'gi') });
  }
}

const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !SKIP.has(f) && existsSync(f));

let found = 0;
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const { name, regex, allow } of patterns) {
      for (const match of line.matchAll(regex)) {
        if (allow?.(match[0])) continue;
        console.error(`${file}:${i + 1}: ${name}`);
        found++;
      }
    }
  });
}

if (found) {
  console.error(`\n${found} possible leak(s). Use placeholders such as example.com and 000000000000.`);
  process.exit(1);
}
console.log(`No leaks found in ${files.length} files.`);
