// Test helpers for the stacks.
import { loadConfigFile } from '@passa/shared';
import { App } from 'aws-cdk-lib';

export const exampleConfig = () => loadConfigFile(new URL('../../../config.example.yml', import.meta.url).pathname);

// An app that skips bundling Lambda code, which the stack tests don't look at.
export const testApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });
