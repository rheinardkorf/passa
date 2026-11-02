// Draws social cards (M3 R95, R96): a card's HTML, laid out by Satori, made a
// 1200×630 PNG by resvg (WebAssembly). Only the fonts and images passed in are
// used; nothing is fetched or read from anywhere else.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori from 'satori';
import { html as toVNode } from 'satori-html';
import { INTER_400, INTER_700 } from './default-fonts.ts';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

export type CardFont = { name: string; weight: 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900; style: 'normal' | 'italic'; data: Uint8Array };

const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
// The default card's fonts, for a theme without its own card.
export const DEFAULT_CARD_FONTS: CardFont[] = [
  { name: 'Inter', weight: 400, style: 'normal', data: fromBase64(INTER_400) },
  { name: 'Inter', weight: 700, style: 'normal', data: fromBase64(INTER_700) },
];

// A theme's card fonts are _layouts/fonts/Family__weight__style.(woff|ttf|otf).
export const CARD_FONT = /^_layouts\/fonts\/([^/]+)\.(woff|ttf|otf)$/i;
export function cardFont(path: string, data: Uint8Array): CardFont | undefined {
  const m = CARD_FONT.exec(path);
  if (!m) return undefined;
  const [family = '', weight = '400', style = 'normal'] = (m[1] ?? '').split('__');
  const w = Math.min(900, Math.max(100, Math.round(Number(weight) / 100) * 100 || 400)) as CardFont['weight'];
  return { name: family, weight: w, style: style === 'italic' ? 'italic' : 'normal', data };
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

// resvg's WebAssembly: beside the bundle in Lambda (copied there at build
// time), else from the installed package.
let ready: Promise<void> | undefined;
function loadWasm(): Promise<void> {
  return (ready ??= (async () => {
    const beside = new URL('./resvg.wasm', import.meta.url);
    const path = existsSync(beside) ? beside : createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
    await initWasm(readFileSync(path));
  })());
}

// Draws one card. Images (<img src>) are the site paths the render listed for
// the card, embedded from image(path); the HTML names no other kind.
export async function drawCard(html: string, options: { fonts: CardFont[]; image: (path: string) => Uint8Array | undefined }): Promise<Uint8Array> {
  await loadWasm();
  const embedded = html.replace(/(<img\b[^>]*\ssrc=")(\/[^"]+)(")/g, (_, before: string, src: string, after: string) => {
    const path = decodeURIComponent(src.slice(1));
    const data = options.image(path);
    if (!data) throw new Error(`card image ${src} isn't in the site`);
    const type = MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    return `${before}data:${type};base64,${Buffer.from(data).toString('base64')}${after}`;
  });
  const svg = await satori(toVNode(embedded) as Parameters<typeof satori>[0], { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: options.fonts.map((f) => ({ ...f, data: Buffer.from(f.data) })) });
  return new Resvg(svg, { fitTo: { mode: 'width', value: CARD_WIDTH } }).render().asPng();
}
