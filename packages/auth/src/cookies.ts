// Host-only cookies by construction: __Host- requires Secure, Path=/ and no Domain.
export const SESSION_COOKIE = '__Host-passa-session';
export const CSRF_COOKIE = '__Host-passa-csrf';

export function readCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}
