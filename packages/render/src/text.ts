// Small text and path helpers shared by the renderer.

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '');
export const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');

// Resolves a relative URL against the folder of the source file it's written in.
export function resolveFrom(sourceDir: string, href: string): string {
  const out: string[] = [];
  for (const part of `/${sourceDir}${href}`.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.') out.push(part);
  }
  return out.join('/') || '/';
}

// index.md → <dir>/index.html; notes/plan.md → notes/plan/index.html (R67).
export function outputOf(source: string): { file: string; url: string } {
  const dir = dirOf(source);
  const base = baseOf(source);
  const folder = base.toLowerCase() === 'index' ? dir : `${dir}${base}/`;
  return { file: `${folder}index.html`, url: `/${folder}` };
}
