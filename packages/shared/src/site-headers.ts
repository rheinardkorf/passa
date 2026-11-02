// Response headers for every site (CloudFront response headers policy, and the
// local proxy). Pages may run inline scripts, but can't send data anywhere:
// no fetch, XHR or WebSockets, no form posts, no frames, and images and media
// only from the site itself.
import { contentSecurityPolicy } from '@passa/csp';
import type { Config } from './config.ts';

// The policy itself is in @passa/csp, which has no dependencies.
export { contentSecurityPolicy };

export function siteHeaders(config: Pick<Config, 'cdnAllowlist'>): Record<string, string> {
  return {
    'content-security-policy': contentSecurityPolicy(config.cdnAllowlist),
    // Files are immutable at the edge, but viewers must revalidate so an update
    // or rollback shows at once, and nothing private lands in shared caches.
    'cache-control': 'private, no-cache',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    // No x-robots-tag here: it depends on the host (M2 R42), so the edge's
    // viewer-response function (edge/src/response.js) sets it.
  };
}
