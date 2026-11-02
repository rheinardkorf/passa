// Widgets: fenced blocks Passa renders instead of showing as code. Each one
// turns its contents into data and renders a template, so a theme can replace
// any of these with _layouts/widgets/<name>.html, or add its own names.
//
// Data a template gets: the widget's own fields (or `items` for a list), the
// fence's options (```stats columns=3 → options.columns), `site`, and a
// `markdown` lambda: {{#markdown}}{{text}}{{/markdown}} renders inline Markdown.
//
// Built-in classes all start with w- so they can't collide with a theme's own.

import { escapeHtml } from './text.ts';

export const DEFAULT_WIDGETS: Record<string, string> = {
  mermaid: '<pre class="mermaid">{{code}}</pre>',
  gallery: '<div class="w-gallery">{{#items}}<figure><img src="{{src}}" alt="{{alt}}" loading="lazy">{{#alt}}<figcaption>{{alt}}</figcaption>{{/alt}}</figure>{{/items}}</div>',
  timeline: '<ol class="w-timeline">{{#items}}<li><span class="w-when">{{when}}</span><span class="w-what">{{{what}}}</span></li>{{/items}}</ol>',
  chart: '{{{svg}}}',
  cards: '<ul class="w-cards">{{#items}}<li class="w-card">{{#title}}<p class="w-card-title">{{#markdown}}{{title}}{{/markdown}}</p>{{/title}}{{#text}}<p class="w-card-text">{{#markdown}}{{text}}{{/markdown}}</p>{{/text}}</li>{{/items}}</ul>',
  stats: '<dl class="w-stats">{{#items}}<div class="w-stat"><dt>{{label}}</dt><dd>{{value}}</dd></div>{{/items}}</dl>',
};

// What a built-in widget's data must look like, or it would render empty
// (R76): the reason, or undefined when it's fine. A theme's own template for a
// widget decides its own data, so this applies to the built-ins only.
export function widgetShapeProblem(name: string, data: Record<string, unknown>, lines: string[]): string | undefined {
  const items = Array.isArray(data.items) ? (data.items as unknown[]) : undefined;
  const every = (ok: (item: Record<string, unknown>) => boolean) => !!items?.length && items.every((i) => !!i && typeof i === 'object' && ok(i as Record<string, unknown>));
  if (name === 'cards' && !every((i) => i.title !== undefined || i.text !== undefined)) return 'each card needs a title or text, as a YAML list: - title: …';
  if (name === 'stats' && !every((i) => i.label !== undefined && i.value !== undefined)) return 'each stat needs a label and a value, as a YAML list: - label: … value: …';
  if (name === 'gallery' && items?.length !== lines.length) return 'each line must be an image: ![caption](path)';
  if (name === 'timeline' && items?.length !== lines.length) return 'each line must be "when: what"';
  return undefined;
}

const esc = (s: unknown) => escapeHtml(String(s));

// Rounds a chart's top value up to 1, 2, 2.5 or 5 times a power of ten.
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}

// A chart's defaults, at zero specificity (:where), so any theme rule wins.
// Series fade from currentColor until a theme colours .w-series-N; axis text
// grows on narrow screens, where the SVG scales down.
const CHART_STYLE = '<style>'
  + ':where(.w-chart) svg{width:100%;height:auto;overflow:visible}'
  + ':where(.w-chart) :where(.w-series-2){opacity:.6}:where(.w-chart) :where(.w-series-3){opacity:.35}:where(.w-chart) :where(.w-series-4){opacity:.2}'
  + ':where(.w-chart-grid){stroke:currentColor;stroke-opacity:.15}:where(.w-chart-axis){font-size:12px;fill:currentColor;fill-opacity:.7}'
  + ':where(.w-chart-legend){list-style:none;padding:0;display:flex;flex-wrap:wrap;gap:.4em 1em;justify-content:center}'
  + ':where(.w-swatch){display:inline-block;width:.75em;height:.75em;margin-right:.35em;background:currentColor;vertical-align:baseline}'
  + '@media (max-width:600px){:where(.w-chart-axis){font-size:20px}}'
  + '</style>';

// chart: bar or line, drawn as SVG at publish time, so it needs no script and
// works in feeds. Marks use currentColor; themes restyle .w-series-N.
//   type: bar | line
//   title: Points by season
//   labels: [2023, 2024, 2025]
//   series: [{ name: Oscar, values: [97, 292, 410] }]
// or, for one series: values: { 2023: 97, 2024: 292 }
type Series = { name: string; values: number[] };

export function chartSvg(data: Record<string, unknown>): string {
  let labels = Array.isArray(data.labels) ? data.labels.map(String) : [];
  let raw: unknown[] = Array.isArray(data.series) ? data.series : [];
  if (!raw.length && data.values && typeof data.values === 'object') {
    if (Array.isArray(data.values)) raw = [{ values: data.values }];
    else {
      labels = Object.keys(data.values);
      raw = [{ values: Object.values(data.values) }];
    }
  }
  const series: Series[] = raw.map((s, i) => {
    const entry = (s && typeof s === 'object' ? s : {}) as { name?: unknown; values?: unknown };
    return { name: entry.name ? String(entry.name) : `Series ${i + 1}`, values: (Array.isArray(entry.values) ? entry.values : []).map(Number) };
  });
  const n = Math.max(labels.length, ...series.map((s) => s.values.length));
  if (!n || !series.length || series.some((s) => s.values.some((v) => !Number.isFinite(v)))) throw new Error('a chart needs labels and numeric values');
  const type = data.type === 'line' ? 'line' : 'bar';
  const W = 640, H = 300, L = 44, R = 8, T = 12, B = 28;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values)));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const slot = (W - L - R) / n;
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const v = max * f;
    return `<line class="w-chart-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="w-chart-axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
  }).join('');
  const xLabels = Array.from({ length: n }, (_, i) => `<text class="w-chart-axis" x="${L + slot * (i + 0.5)}" y="${H - 8}" text-anchor="middle">${esc(labels[i] ?? '')}</text>`).join('');
  const marks = series.map((s, si) => {
    const cls = `w-chart-series w-series-${si + 1}`;
    if (type === 'line') {
      const pts = s.values.map((v, i): [number, number] => [L + slot * (i + 0.5), y(v)]);
      return `<g class="${cls}"><polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="2.5"/>${pts.map(([cx, cy], i) => `<circle cx="${cx}" cy="${cy}" r="3.5" fill="currentColor"><title>${esc(`${s.name}, ${labels[i] ?? i + 1}: ${s.values[i]}`)}</title></circle>`).join('')}</g>`;
    }
    const bw = (slot * 0.7) / series.length;
    return `<g class="${cls}" fill="currentColor">${s.values.map((v, i) => `<rect x="${L + slot * i + slot * 0.15 + bw * si}" y="${y(v)}" width="${bw}" height="${y(0) - y(v)}" rx="2"><title>${esc(`${s.name}, ${labels[i] ?? i + 1}: ${v}`)}</title></rect>`).join('')}</g>`;
  }).join('');
  const title = data.title ? String(data.title) : '';
  const legend = series.length > 1 ? `<ul class="w-chart-legend">${series.map((s, i) => `<li><span class="w-swatch w-series-${i + 1}"></span>${esc(s.name)}</li>`).join('')}</ul>` : '';
  return `<figure class="w-chart w-chart-${type}">${CHART_STYLE}${title ? `<figcaption>${esc(title)}</figcaption>` : ''}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || 'Chart')}">${grid}${xLabels}${marks}</svg>${legend}</figure>`;
}

// Fence options: `name key=value key="two words" flag` → { key: 'value', flag: true }.
export function parseOptions(text: string): Record<string, string | true> {
  const options: Record<string, string | true> = {};
  for (const m of text.matchAll(/([a-z][\w-]*)(?:=(?:"([^"]*)"|(\S+)))?/gi)) if (m[1]) options[m[1]] = m[2] ?? m[3] ?? true;
  return options;
}
