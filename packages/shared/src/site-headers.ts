// Response headers for every site (CloudFront response headers policy, and the
// local proxy). Pages may run inline scripts, but can't send data anywhere:
// no fetch, XHR or WebSockets, no form posts, no frames, and images and media
// only from the site itself.
import type { Config } from './config.ts';

export function contentSecurityPolicy(cdnAllowlist: string[]): string {
  const cdns = cdnAllowlist.map((host) => `https://${host}`).join(' ');
  return [
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' ${cdns}`,
    `style-src 'self' 'unsafe-inline' ${cdns}`,
    `font-src 'self' ${cdns}`,
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "manifest-src 'self'",
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

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
  };
}
