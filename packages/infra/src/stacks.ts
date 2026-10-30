// Every stack of one stage (dev or prod), in that stage's account. Most run in
// the config's region; what CloudFront needs (certificates, WAF) is in
// us-east-1. Stacks are named passa-<stage>-<part> and tagged, so a deployment
// can share its accounts with other projects.
import { type Config, type Stage, stageConfig } from '@passa/shared';
import { type App, Tags } from 'aws-cdk-lib';
import { DataStack } from './data.ts';
import { FoundationStack } from './foundation.ts';
import { GlobalStack } from './global.ts';
import { ServicesStack } from './services.ts';
import { SitesStack } from './sites.ts';

export function addStage(app: App, base: Config, stage: Stage) {
  const config = stageConfig(base, stage);
  const prod = stage === 'prod';
  const account = config.accounts[stage];
  const props = {
    env: { account, region: config.region },
    terminationProtection: prod,
    crossRegionReferences: true,
  };
  const name = (part: string) => `passa-${stage}-${part}`;

  const foundation = new FoundationStack(app, name('foundation'), { ...props, config });
  // Production keeps its data if a stack is ever deleted.
  const data = new DataStack(app, name('data'), { ...props, config, stage, keep: prod });
  const global = new GlobalStack(app, name('global'), { ...props, env: { account, region: 'us-east-1' }, config, stage, zone: foundation.zone, siteZone: foundation.siteZone });
  const services = new ServicesStack(app, name('services'), {
    ...props,
    config,
    stage,
    zone: foundation.zone,
    data,
    authCertificate: global.authCertificate,
    webAclArn: global.webAcl.attrArn,
  });

  const sites = new SitesStack(app, name('sites'), { ...props, config, stage, siteZone: foundation.siteZone, data, certificate: global.siteCertificate });

  const stacks = { foundation, data, global, services, sites };
  for (const stack of Object.values(stacks)) {
    Tags.of(stack).add('project', 'passa');
    Tags.of(stack).add('stage', stage);
  }
  return stacks;
}
