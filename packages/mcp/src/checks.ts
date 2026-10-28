// Publish-time checks. A site is refused unless every file passes: safe paths,
// size limits, a known file type that matches the content, and no secrets.
// Malware scanning happens in S3 (GuardDuty Malware Protection), not here.
import { createHash } from 'node:crypto';
import { fileTypeFromBuffer } from 'file-type';
import type { Config, FileEntry } from '@passa/shared';

export type InputFile = { path: string; content: Uint8Array };
export type CheckedFile = FileEntry & { content: Uint8Array };

export class PublishRefused extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Publish refused: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export const MAX_PATH_LENGTH = 200;
// One segment per path part, from a conservative set of characters, so paths
// are safe as S3 keys, URLs and edge rewrites without any escaping.
const SEGMENT = /^[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*$|^\.[A-Za-z0-9._~@+-]+$/;

// Text types are checked as UTF-8 with no binary signature. Binary types must
// carry the signature file-type detects for them.
type FileKind = { contentType: string; text: true } | { contentType: string; text?: false; signatures: string[] };

const KINDS: Record<string, FileKind> = {
  html: { contentType: 'text/html; charset=utf-8', text: true },
  htm: { contentType: 'text/html; charset=utf-8', text: true },
  css: { contentType: 'text/css; charset=utf-8', text: true },
  js: { contentType: 'text/javascript; charset=utf-8', text: true },
  mjs: { contentType: 'text/javascript; charset=utf-8', text: true },
  json: { contentType: 'application/json; charset=utf-8', text: true },
  map: { contentType: 'application/json; charset=utf-8', text: true },
  webmanifest: { contentType: 'application/manifest+json; charset=utf-8', text: true },
  txt: { contentType: 'text/plain; charset=utf-8', text: true },
  md: { contentType: 'text/markdown; charset=utf-8', text: true },
  csv: { contentType: 'text/csv; charset=utf-8', text: true },
  xml: { contentType: 'application/xml; charset=utf-8', text: true },
  svg: { contentType: 'image/svg+xml; charset=utf-8', text: true },
  png: { contentType: 'image/png', signatures: ['png'] },
  jpg: { contentType: 'image/jpeg', signatures: ['jpg'] },
  jpeg: { contentType: 'image/jpeg', signatures: ['jpg'] },
  gif: { contentType: 'image/gif', signatures: ['gif'] },
  webp: { contentType: 'image/webp', signatures: ['webp'] },
  avif: { contentType: 'image/avif', signatures: ['avif'] },
  ico: { contentType: 'image/x-icon', signatures: ['ico', 'cur'] },
  woff: { contentType: 'font/woff', signatures: ['woff'] },
  woff2: { contentType: 'font/woff2', signatures: ['woff2'] },
  ttf: { contentType: 'font/ttf', signatures: ['ttf'] },
  otf: { contentType: 'font/otf', signatures: ['otf'] },
  pdf: { contentType: 'application/pdf', signatures: ['pdf'] },
  mp4: { contentType: 'video/mp4', signatures: ['mp4', 'm4v'] },
  webm: { contentType: 'video/webm', signatures: ['webm'] },
  mp3: { contentType: 'audio/mpeg', signatures: ['mp3'] },
};

// Signatures file-type may report for plain text, which are fine in text files.
const TEXT_SIGNATURES = new Set(['xml', 'svg']);

// Credentials that should never be published. Names only are reported, never
// the matched value.
const SECRETS: { name: string; regex: RegExp }[] = [
  { name: 'AWS access key', regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'GitHub token', regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: 'Slack token', regex: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe secret key', regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Anthropic API key', regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI API key', regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{40,}\b/ },
  { name: 'JSON web token', regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const utf8 = new TextDecoder('utf-8', { fatal: true });

export type PathResult = { ok: true; skip: boolean } | { ok: false; problem: string };

// Validates one path. Dotfiles (any segment starting with ".") are skipped,
// not refused, so agents can publish a folder as it is.
export function checkPath(path: string): PathResult {
  const shown = JSON.stringify(path.slice(0, MAX_PATH_LENGTH));
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return { ok: false, problem: `${shown}: paths must be 1–${MAX_PATH_LENGTH} characters` };
  const segments = path.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..' || !SEGMENT.test(s))) {
    return { ok: false, problem: `${shown}: use relative paths of letters, digits and . _ ~ @ + - only` };
  }
  if (segments[0]?.toLowerCase() === '_passa') return { ok: false, problem: `${shown}: /_passa/ is reserved` };
  if (segments.some((s) => s.startsWith('.'))) return { ok: true, skip: true };
  return { ok: true, skip: false };
}

export function kindOf(path: string): FileKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? KINDS[name.slice(dot + 1).toLowerCase()] : undefined;
}

export type Limits = Config['limits'];

// Checks paths, counts and sizes before any content is read or stored. Used
// for inline files and for the file list given to begin_upload.
export function checkManifest(files: { path: string; size: number }[], limits: Limits, totalLimit: number): { keep: Set<string>; skipped: string[] } {
  const problems: string[] = [];
  const keep = new Set<string>();
  const skipped: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { path, size } of files) {
    const result = checkPath(path);
    if (!result.ok) {
      problems.push(result.problem);
      continue;
    }
    if (seen.has(path.toLowerCase())) {
      problems.push(`${path}: listed twice`);
      continue;
    }
    seen.add(path.toLowerCase());
    if (result.skip) {
      skipped.push(path);
      continue;
    }
    if (!kindOf(path)) problems.push(`${path}: this file type can't be published`);
    if (size > limits.file) problems.push(`${path}: larger than the ${limits.file}-byte file limit`);
    total += size;
    keep.add(path);
  }
  if (keep.size === 0 && problems.length === 0) problems.push('no files to publish');
  if (keep.size > limits.files) problems.push(`more than ${limits.files} files`);
  if (total > totalLimit) problems.push(`larger than the ${totalLimit}-byte total limit`);
  if (problems.length) throw new PublishRefused(problems);
  return { keep, skipped };
}

// Checks content: the type matches the extension, and text has no secrets.
export async function checkContent(files: InputFile[]): Promise<CheckedFile[]> {
  const problems: string[] = [];
  const checked: CheckedFile[] = [];
  for (const { path, content } of files) {
    const kind = kindOf(path);
    if (!kind) {
      problems.push(`${path}: this file type can't be published`);
      continue;
    }
    const detected = (await fileTypeFromBuffer(content))?.ext;
    if (kind.text) {
      if (detected && !TEXT_SIGNATURES.has(detected)) {
        problems.push(`${path}: content looks like ${detected}, not text`);
        continue;
      }
      let text: string;
      try {
        text = utf8.decode(content);
      } catch {
        problems.push(`${path}: not valid UTF-8 text`);
        continue;
      }
      const secret = SECRETS.find(({ regex }) => regex.test(text));
      if (secret) {
        problems.push(`${path}: contains what looks like a ${secret.name}`);
        continue;
      }
    } else if (!detected || !kind.signatures.includes(detected)) {
      problems.push(`${path}: content doesn't match its file type`);
      continue;
    }
    checked.push({
      path,
      content,
      size: content.byteLength,
      contentType: kind.contentType,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  if (problems.length) throw new PublishRefused(problems);
  return checked;
}
