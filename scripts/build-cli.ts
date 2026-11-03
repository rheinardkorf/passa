// Builds the passa command as the npm package `passa`, in packages/cli/dist/npm.
// Passa's own packages are private, so they're bundled in; the libraries they
// use stay ordinary dependencies, pinned to the versions the repo tests, so
// their licenses ship with them and npm audit sees them. npm-shrinkwrap.json
// pins the whole tree, at versions at least 14 days old, so installing passa
// gets exactly what was tested rather than whatever was published that day.
// Publish with: npm publish packages/cli/dist/npm
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const MIN_AGE_DAYS = 14;
const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'packages/cli');
const out = join(cli, 'dist/npm');

type Manifest = { name: string; version?: string; description?: string; license?: string; dependencies?: Record<string, string> };
const manifest = (path: string) => JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as Manifest;
const own = manifest('packages/cli');
const top = manifest('.') as Manifest & { engines?: Record<string, string> };

// Third-party dependencies of the CLI and the Passa packages it bundles.
const dependencies: Record<string, string> = {};
const bundled = new Set<string>();
const collect = (pkg: Manifest) => {
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (spec.startsWith('workspace:')) {
      if (bundled.has(name)) continue;
      bundled.add(name);
      collect(manifest(`packages/${name.replace('@passa/', '')}`));
    } else if (dependencies[name] && dependencies[name] !== spec) {
      throw new Error(`${name} is pinned to both ${dependencies[name]} and ${spec}`);
    } else {
      dependencies[name] = spec;
    }
  }
};
collect(own);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(cli, 'src/main.ts')],
  outfile: join(out, 'passa.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: Object.keys(dependencies),
  define: { PASSA_VERSION: JSON.stringify(own.version) },
  legalComments: 'none',
  logLevel: 'warning',
});

writeFileSync(join(out, 'package.json'), `${JSON.stringify({
  name: 'passa',
  version: own.version,
  description: own.description,
  license: own.license,
  author: 'Rheinard Korf',
  homepage: 'https://github.com/rheinardkorf/passa#readme',
  repository: { type: 'git', url: 'git+https://github.com/rheinardkorf/passa.git', directory: 'packages/cli' },
  bugs: 'https://github.com/rheinardkorf/passa/issues',
  keywords: ['markdown', 'static-site', 'publishing', 'mcp', 'cli'],
  type: 'module',
  bin: { passa: 'passa.js' },
  files: ['passa.js', 'npm-shrinkwrap.json', 'README.md', 'LICENSE'],
  engines: top.engines,
  dependencies: Object.fromEntries(Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))),
}, null, 2)}\n`);
copyFileSync(join(cli, 'README.md'), join(out, 'README.md'));
copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

const before = new Date(Date.now() - MIN_AGE_DAYS * 86_400_000).toISOString().slice(0, 10);
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`], { cwd: out, stdio: 'inherit' });
renameSync(join(out, 'package-lock.json'), join(out, 'npm-shrinkwrap.json'));

console.log(`Built passa ${own.version} in ${out} (bundled ${[...bundled].join(', ')}; ${Object.keys(dependencies).length} dependencies).`);
