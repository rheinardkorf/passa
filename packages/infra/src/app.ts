// The CDK app. Run from packages/infra: `pnpm cdk deploy -c stage=dev --all`.
// Reads the repo's config.yml, or the file PASSA_CONFIG names.
import { resolve } from 'node:path';
import { loadConfigFile, STAGES, type Stage } from '@passa/shared';
import { App } from 'aws-cdk-lib';
import { addStage } from './stacks.ts';

const app = new App();
const stage = app.node.tryGetContext('stage') as string | undefined;
if (!STAGES.includes(stage as Stage)) throw new Error(`Choose a stage: -c stage=${STAGES.join('|')}`);

const config = loadConfigFile(process.env.PASSA_CONFIG ?? resolve(import.meta.dirname, '../../../config.yml'));
addStage(app, config, stage as Stage);
app.synth();
