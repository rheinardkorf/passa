import { describe, expect, it } from 'vitest';
import { checkContent, checkManifest, checkPath, PublishRefused } from './checks.ts';

const limits = { inlinePublish: 1000, site: 5000, file: 600, files: 3 };
const text = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function refusal(promise: Promise<unknown> | (() => unknown)) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (err) {
    if (err instanceof PublishRefused) return err.problems;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('paths', () => {
  it('accepts ordinary relative paths', () => {
    for (const p of ['index.html', 'css/site.css', 'img/logo@2x.png', 'a-b_c~d+e.js']) expect(checkPath(p)).toEqual({ ok: true, skip: false });
  });

  it('refuses paths that could escape or confuse', () => {
    for (const p of ['', '/index.html', 'a//b.html', './a.html', '../a.html', 'a/../b.html', 'a\\b.html', 'a b.html', 'a/', 'ü.html', 'x'.repeat(201)]) {
      expect(checkPath(p).ok, p).toBe(false);
    }
  });

  it('refuses the reserved /_passa/ path in any case (R14)', () => {
    expect(checkPath('_passa/x.html').ok).toBe(false);
    expect(checkPath('_PASSA/x.html').ok).toBe(false);
    expect(checkPath('docs/_passa/x.html').ok).toBe(true);
  });

  it('skips dotfiles and dot folders', () => {
    expect(checkPath('.env')).toEqual({ ok: true, skip: true });
    expect(checkPath('.git/config')).toEqual({ ok: true, skip: true });
    expect(checkPath('a/.DS_Store')).toEqual({ ok: true, skip: true });
  });
});

describe('manifest', () => {
  it('reports skipped files and keeps the rest', () => {
    const { keep, skipped } = checkManifest([{ path: 'index.html', size: 10 }, { path: '.env', size: 10 }], limits, limits.site);
    expect([...keep]).toEqual(['index.html']);
    expect(skipped).toEqual(['.env']);
  });

  it('enforces file, total and count limits', async () => {
    expect(await refusal(() => checkManifest([{ path: 'a.html', size: 601 }], limits, limits.site))).toEqual([expect.stringContaining('file limit')]);
    expect(await refusal(() => checkManifest([{ path: 'a.html', size: 600 }, { path: 'b.html', size: 600 }], limits, 1000))).toEqual([expect.stringContaining('total limit')]);
    const four = ['a', 'b', 'c', 'd'].map((n) => ({ path: `${n}.html`, size: 1 }));
    expect(await refusal(() => checkManifest(four, limits, limits.site))).toEqual(['more than 3 files']);
  });

  it('refuses unknown types, duplicates (ignoring case) and empty sites', async () => {
    expect(await refusal(() => checkManifest([{ path: 'run.exe', size: 1 }], limits, limits.site))).toEqual([expect.stringContaining("can't be published")]);
    expect(await refusal(() => checkManifest([{ path: 'a.html', size: 1 }, { path: 'A.html', size: 1 }], limits, limits.site))).toEqual([expect.stringContaining('listed twice')]);
    expect(await refusal(() => checkManifest([{ path: '.env', size: 1 }], limits, limits.site))).toEqual(['no files to publish']);
  });
});

describe('content', () => {
  it('accepts text and binary files whose content matches their type', async () => {
    const checked = await checkContent([
      { path: 'index.html', content: text('<h1>Hi</h1>') },
      { path: 'logo.svg', content: text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>') },
      { path: 'logo.png', content: PNG },
    ]);
    expect(checked.map((f) => f.contentType)).toEqual(['text/html; charset=utf-8', 'image/svg+xml; charset=utf-8', 'image/png']);
    expect(checked[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses content that does not match its extension', async () => {
    expect(await refusal(checkContent([{ path: 'photo.png', content: text('<script>alert(1)</script>') }]))).toEqual([expect.stringContaining("doesn't match")]);
    expect(await refusal(checkContent([{ path: 'page.html', content: PNG }]))).toEqual([expect.stringContaining('looks like png')]);
    expect(await refusal(checkContent([{ path: 'page.html', content: new Uint8Array([0xff, 0xfe, 0x00]) }]))).toEqual([expect.stringContaining('UTF-8')]);
  });

  it('refuses text containing credentials, without echoing them', async () => {
    // Built at runtime so this file doesn't itself look like it holds secrets.
    const samples = [
      'AKIA' + 'Q'.repeat(16),
      '-----BEGIN ' + 'RSA PRIVATE KEY-----',
      'ghp_' + 'a1'.repeat(18),
      'sk_live_' + 'x'.repeat(24),
      'sk-ant-' + 'api03-' + 'z'.repeat(30),
    ];
    for (const secret of samples) {
      const problems = await refusal(checkContent([{ path: 'app.js', content: text(`const key = "${secret}";`) }]));
      expect(problems).toEqual([expect.stringContaining('looks like a')]);
      expect(problems.join()).not.toContain(secret);
    }
  });
});
