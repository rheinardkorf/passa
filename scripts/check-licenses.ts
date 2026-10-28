// Fails if any installed dependency uses a license outside the allowlist, so
// nothing incompatible with Passa's MIT license ships with it. Dev tools
// (build, lint, test) are not distributed, so they are not checked.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
]);

type Entry = { name: string; versions: string[] };
const output = execFileSync('pnpm', ['licenses', 'list', '--json', '--prod'], { encoding: 'utf8' });
const byLicense = JSON.parse(output) as Record<string, Entry[]>;

const isAllowed = (license: string) =>
  license
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((alternative) => alternative.split(/\s+AND\s+/).every((part) => ALLOWED.has(part.trim())));

let bad = 0;
for (const [license, packages] of Object.entries(byLicense)) {
  if (isAllowed(license)) continue;
  for (const pkg of packages) {
    console.error(`${pkg.name}@${pkg.versions.join(', ')}: ${license}`);
    bad++;
  }
}

if (bad) {
  console.error(`\n${bad} package(s) with a license that isn't allowed.`);
  process.exit(1);
}
console.log(`All ${Object.values(byLicense).flat().length} packages have allowed licenses.`);
