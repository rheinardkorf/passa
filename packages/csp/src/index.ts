// The Content Security Policy every Passa site is served with: pages may run
// inline scripts, but can't send data anywhere (no fetch, XHR or WebSockets,
// no form posts, no frames), and images and media come only from the site
// itself. Its own package, with no dependencies, so the edge, the infra and
// the passa command can all use it without pulling in each other's.

// The CDNs config.example.yml allows, for local previews.
export const DEFAULT_CDN_ALLOWLIST = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

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
