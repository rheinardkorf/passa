// Lambda functions built from the repo's TypeScript with esbuild: Node.js LTS
// on ARM, ESM bundles, and a log group that keeps logs for a month.
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
};

export function nodeFunction(scope: Construct, id: string, props: FunctionProps): NodejsFunction {
  const { entry, removalPolicy, ...rest } = props;
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
    },
    ...rest,
  });
}
