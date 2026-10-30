// Site names (M2 R44): a single DNS label that becomes a site's address, such
// as cv.<siteDomain>. Names can't match the site ID pattern, so the edge tells
// them apart by shape.
import { isSiteId } from './ids.ts';

// 2–40 lowercase letters, digits and single hyphens, not at either end. No "--",
// which also rules out IDN ("xn--") lookalikes. The edge handler has the same
// pattern, and a test keeps them equal.
export const NAME_PATTERN = /^(?=[a-z0-9-]{2,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Labels with other uses on the site domain. Deployments add their own in config.
export const RESERVED_NAMES = ['www', 'mail', 'auth', 'mcp', 'api', 'dev', 'admin', 'status'];

export const isName = (value: string): boolean => NAME_PATTERN.test(value) && !isSiteId(value);

// Why a name can't be used, or undefined when it can.
export function nameProblem(name: string, reserved: string[]): string | undefined {
  if (!NAME_PATTERN.test(name)) return 'Use 2–40 lowercase letters, digits and single hyphens, not starting or ending with a hyphen.';
  if (isSiteId(name)) return 'That looks like a site ID. Choose a name that doesn\'t.';
  if (RESERVED_NAMES.includes(name) || reserved.includes(name)) return 'That name is reserved.';
  return undefined;
}
