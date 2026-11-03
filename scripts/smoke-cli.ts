// Builds the passa npm package, installs the packed tarball into an empty
// folder as a user would, and runs it: the check before publishing, and in CI
// so the package can't quietly break between releases.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const pkg = join(root, 'packages/cli/dist/npm');
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

run('node', [join(root, 'scripts/build-cli.ts')], root);
const work = mkdtempSync(join(tmpdir(), 'passa-smoke-'));
const tarball = run('npm', ['pack', '--silent', '--pack-destination', work], pkg).trim().split('\n').at(-1) ?? '';
const app = join(work, 'app');
mkdirSync(app);
run('npm', ['init', '-y'], app);
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(work, tarball)], app);

const passa = (...args: string[]) => run(join(app, 'node_modules/.bin/passa'), args, app);
const version = passa('--version').trim();
passa('init', 'site');
passa('render', 'site', '--out', 'out');
passa('check', 'site');
const cards = readdirSync(join(app, 'out/first-post')).filter((f) => f.startsWith('_card-'));
if (!existsSync(join(app, 'out/index.html')) || cards.length !== 1) throw new Error('passa render didn\'t build the starter site with its cards');
console.log(`passa ${version} installs from ${tarball} and builds a site, with social cards.`);
