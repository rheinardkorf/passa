// Lambda functions built from the repo's TypeScript with esbuild: Node.js LTS
// on ARM, ESM bundles, and a log group that keeps logs for a month.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, type NodejsFunctionProps, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export type FunctionProps = Pick<NodejsFunctionProps, 'environment' | 'memorySize' | 'timeout' | 'description'> & {
  entry: string; // relative to the repo root
  removalPolicy: RemovalPolicy;
  // Draws social cards: resvg's WebAssembly goes beside the bundle, where
  // render/src/cards.ts looks for it.
  cards?: boolean;
};

const RESVG_WASM = createRequire(resolve(REPO_ROOT, 'packages/render/package.json')).resolve('@resvg/resvg-wasm/index_bg.wasm');

export function nodeFunction(scope: Construct, id: string, props: FunctionProps): NodejsFunction {
  const { entry, removalPolicy, cards, ...rest } = props;
  return new NodejsFunction(scope, id, {
    entry: resolve(REPO_ROOT, entry),
    projectRoot: REPO_ROOT,
    depsLockFilePath: resolve(REPO_ROOT, 'pnpm-lock.yaml'),
    runtime: Runtime.NODEJS_24_X,
    architecture: Architecture.ARM_64,
    memorySize: 1024,
    timeout: Duration.seconds(15),
    logGroup: new LogGroup(scope, `${id}Logs`, { retention: RetentionDays.ONE_MONTH, removalPolicy }),
    bundling: {
      format: OutputFormat.ESM,
      target: 'node24',
      mainFields: ['module', 'main'],
      // The SDK is bundled too, at the lockfile's versions, rather than taken
      // from the runtime: the SigV4a signer must register with the same copy.
      externalModules: [],
      minify: true,
      keepNames: true, // oidc-provider names its stored records after its classes
      sourceMap: true,
      banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
      ...(cards ? {
        commandHooks: {
          beforeBundling: () => [],
          beforeInstall: () => [],
          afterBundling: (_input: string, output: string) => [`cp "${RESVG_WASM}" "${output}/resvg.wasm"`],
        },
      } : {}),
    },
    ...rest,
  });
}
