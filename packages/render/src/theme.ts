// The default theme: one Mustache layout with its CSS inline, so a site needs
// no theme files. Light and dark, readable measure, code, callouts, tasks,
// footnotes, backlinks and the page list.
const CSS = `
:root{--bg:#fbfaf7;--fg:#1d1d1f;--muted:#6b6b70;--line:#e6e3dc;--accent:#b4531f;--code-bg:#f2efe8;--note:#2f6fb3;--tip:#2f8a5b;--warning:#b7791f;--danger:#b33a3a;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e6e1;--muted:#9a9a9f;--line:#2b2b30;--accent:#ef8a4c;--code-bg:#1e1e22;--note:#6aa7e8;--tip:#5fc58f;--warning:#e2b04a;--danger:#e57373}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:18px/1.65 ui-serif,Georgia,Cambria,"Times New Roman",serif}
.wrap{max-width:42rem;margin:0 auto;padding:2.5rem 1.25rem 4rem}
header.site{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:2.5rem;font:600 .95rem/1.4 ui-sans-serif,system-ui,sans-serif}
header.site a{color:var(--fg);text-decoration:none}
header.site nav a{color:var(--muted);margin-left:1rem}
h1,h2,h3,h4{font-family:ui-sans-serif,system-ui,sans-serif;line-height:1.25;letter-spacing:-.01em;margin:2.2rem 0 .8rem}
h1{font-size:2.1rem;margin-top:0}
h2{font-size:1.45rem}
h3{font-size:1.15rem}
.meta{color:var(--muted);font:.9rem/1.4 ui-sans-serif,system-ui,sans-serif;margin:-.4rem 0 2rem}
.tags span,.tags a{display:inline-block;margin-right:.4rem;padding:.05rem .5rem;border:1px solid var(--line);border-radius:999px}
a{color:var(--accent);text-underline-offset:.15em}
a.wikilink{text-decoration-style:dotted}
.wikilink.missing{color:var(--muted);text-decoration:line-through dotted}
img{max-width:100%;height:auto;border-radius:6px}
hr{border:0;border-top:1px solid var(--line);margin:2.5rem 0}
blockquote{margin:1.5rem 0;padding:.2rem 1.2rem;border-left:3px solid var(--line);color:var(--muted)}
code,pre{font:.86em/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
:not(pre)>code{background:var(--code-bg);padding:.1em .35em;border-radius:4px}
pre{background:var(--code-bg);padding:1rem 1.1rem;border-radius:8px;overflow-x:auto}
pre.mermaid{background:none;text-align:center}
table{border-collapse:collapse;width:100%;font-size:.92em;display:block;overflow-x:auto}
th,td{border-bottom:1px solid var(--line);padding:.45rem .6rem;text-align:left}
li.task{list-style:none;margin-left:-1.3rem}
.callout{border-left:4px solid var(--note);background:color-mix(in srgb,var(--note) 8%,transparent);color:var(--fg);border-radius:0 8px 8px 0;padding:.6rem 1.1rem}
.callout-title{font:600 .95rem/1.4 ui-sans-serif,system-ui,sans-serif;margin:.4rem 0}
.callout-tip,.callout-success{border-color:var(--tip);background:color-mix(in srgb,var(--tip) 8%,transparent)}
.callout-warning,.callout-caution{border-color:var(--warning);background:color-mix(in srgb,var(--warning) 9%,transparent)}
.callout-danger,.callout-important{border-color:var(--danger);background:color-mix(in srgb,var(--danger) 8%,transparent)}
.footnotes{font-size:.9em;color:var(--muted)}
.list{list-style:none;padding:0}
.list li{display:flex;justify-content:space-between;gap:1rem;padding:.55rem 0;border-bottom:1px solid var(--line)}
.list time{color:var(--muted);font:.85rem ui-sans-serif,system-ui,sans-serif;white-space:nowrap}
aside.backlinks{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);font:.92rem/1.5 ui-sans-serif,system-ui,sans-serif}
aside.backlinks h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 .5rem}
.hero{margin:0 0 2.5rem;padding:1.6rem 1.5rem;border-radius:12px;background:color-mix(in srgb,var(--accent) 10%,transparent)}
.hero h1{margin:0 0 .5rem}.hero p{margin:0;font-size:1.1rem;color:var(--muted)}
.w-cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:.8rem}
.w-card{border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem}
.w-card-title{font:600 1rem/1.35 ui-sans-serif,system-ui,sans-serif;margin:0 0 .3rem}.w-card-text{margin:0;color:var(--muted);font-size:.95rem}
.w-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.8rem;margin:1.5rem 0}
.w-stat{border-top:3px solid var(--accent);padding-top:.5rem}.w-stat dt{color:var(--muted);font:.85rem ui-sans-serif,system-ui,sans-serif}.w-stat dd{margin:0;font:700 2rem/1.2 ui-sans-serif,system-ui,sans-serif}
.w-chart{margin:1.8rem 0;color:var(--accent);font-family:ui-sans-serif,system-ui,sans-serif}.w-chart-axis{fill:var(--muted)}
.w-chart figcaption{color:var(--muted);font-size:.85rem;text-align:center;margin-bottom:.4rem}.w-chart-legend{font-size:.85rem;margin:.3rem 0}
.w-gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.6rem;margin:1.5rem 0}.w-gallery figure{margin:0}
.w-gallery img{aspect-ratio:4/3;object-fit:cover;width:100%}.w-gallery figcaption{color:var(--muted);font:.8rem ui-sans-serif,system-ui,sans-serif;margin-top:.25rem}
.w-timeline{list-style:none;padding:0;border-left:2px solid var(--line);margin:1.5rem 0 1.5rem .4rem}
.w-timeline li{padding:0 0 .9rem 1.1rem;position:relative}.w-timeline li::before{content:"";position:absolute;left:-.42rem;top:.5rem;width:.7rem;height:.7rem;border-radius:50%;background:var(--accent)}
.w-when{display:block;font:600 .85rem ui-sans-serif,system-ui,sans-serif;color:var(--muted)}
.hljs-comment,.hljs-quote{color:var(--muted);font-style:italic}
.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#a2477f}
.hljs-string,.hljs-attr,.hljs-template-tag{color:#2f8a5b}
.hljs-number,.hljs-literal,.hljs-type{color:#b7791f}
.hljs-title,.hljs-section,.hljs-function .hljs-title{color:#2f6fb3}
@media (prefers-color-scheme:dark){.hljs-keyword,.hljs-selector-tag,.hljs-built_in{color:#e389c2}.hljs-string,.hljs-attr{color:#7fd6a6}.hljs-number,.hljs-literal,.hljs-type{color:#e8c06a}.hljs-title,.hljs-section{color:#7fb4ee}}
`;

const DEFAULT_LAYOUT = `<!doctype html>
<html lang="{{lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}}{{^isIndex}} · {{site.title}}{{/isIndex}}</title>
{{#description}}<meta name="description" content="{{description}}">{{/description}}
<meta property="og:title" content="{{title}}">
<meta property="og:type" content="{{#date}}article{{/date}}{{^date}}website{{/date}}">
<meta property="og:url" content="{{absoluteUrl}}">
<meta property="og:site_name" content="{{site.title}}">
{{#description}}<meta property="og:description" content="{{description}}">{{/description}}{{^description}}{{#excerpt}}<meta property="og:description" content="{{excerpt}}">{{/excerpt}}{{/description}}
{{#socialImage}}<meta property="og:image" content="{{socialImage}}"><meta name="twitter:card" content="summary_large_image">{{/socialImage}}{{^socialImage}}<meta name="twitter:card" content="summary">{{/socialImage}}
<style>${CSS.trim()}</style>
</head>
<body>
<div class="wrap">
<header class="site"><a href="/">{{site.title}}</a><nav><a href="/feed.xml">Feed</a></nav></header>
<main>
{{#isIndex}}<h1>{{site.title}}</h1>{{/isIndex}}
{{#isTag}}<h1>{{title}}</h1>{{/isTag}}
{{#isPage}}
{{#hero}}<section class="hero"><h1>{{#hero.title}}{{hero.title}}{{/hero.title}}{{^hero.title}}{{page.title}}{{/hero.title}}</h1>{{#hero.text}}<p>{{#markdown}}{{hero.text}}{{/markdown}}</p>{{/hero.text}}</section>{{/hero}}
{{^hero}}{{#showTitle}}<h1>{{title}}</h1>{{/showTitle}}{{/hero}}
{{#dateText}}<p class="meta"><time datetime="{{date}}">{{dateLong}}</time>{{#tags.length}} · <span class="tags">{{#tags}}{{#hasPage}}<a href="{{url}}">{{name}}</a>{{/hasPage}}{{^hasPage}}<span>{{name}}</span>{{/hasPage}}{{/tags}}</span>{{/tags.length}}</p>{{/dateText}}
<article>{{{content}}}</article>
{{/isPage}}
{{^isPage}}<ul class="list">{{#pages}}<li><a href="{{url}}">{{title}}</a>{{#dateText}}<time datetime="{{date}}">{{dateText}}</time>{{/dateText}}</li>{{/pages}}</ul>{{/isPage}}
{{#backlinks.length}}<aside class="backlinks"><h2>Linked from</h2><ul>{{#backlinks}}<li><a href="{{url}}">{{title}}</a></li>{{/backlinks}}</ul></aside>{{/backlinks.length}}
</main>
</div>
{{#mermaid}}<script type="module">import mermaid from '{{{mermaid}}}'; mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });</script>{{/mermaid}}
</body>
</html>
`;

// A deck: one slide per section (--- between slides), full screen, scrolled
// or stepped with the arrow keys. > [!notes] callouts are speaker notes,
// hidden on screen.
const DECK_LAYOUT = `<!doctype html>
<html lang="{{lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{title}} · {{site.title}}</title>
<meta property="og:title" content="{{title}}">
<meta property="og:type" content="{{#date}}article{{/date}}{{^date}}website{{/date}}">
<meta property="og:url" content="{{absoluteUrl}}">
<meta property="og:site_name" content="{{site.title}}">
{{#description}}<meta property="og:description" content="{{description}}">{{/description}}{{^description}}{{#excerpt}}<meta property="og:description" content="{{excerpt}}">{{/excerpt}}{{/description}}
{{#socialImage}}<meta property="og:image" content="{{socialImage}}"><meta name="twitter:card" content="summary_large_image">{{/socialImage}}{{^socialImage}}<meta name="twitter:card" content="summary">{{/socialImage}}
<style>${CSS.trim()}
html{scroll-snap-type:y mandatory}body{margin:0}
.slide{min-height:100vh;min-height:100svh;scroll-snap-align:start;display:flex;flex-direction:column;justify-content:center;padding:6vh 8vw;border-bottom:1px solid var(--line);font-size:clamp(18px,2.4vw,30px)}
.slide h1{font-size:2.6em}.slide h2{font-size:1.8em;margin-top:0}.slide>*{max-width:60rem}
.slide{position:relative}.slide .num{position:absolute;top:3vh;right:3vw;color:var(--muted);font:.6em ui-sans-serif,system-ui,sans-serif}
.callout-notes{display:none}
</style>
</head>
<body>
{{#sections}}<section class="slide" id="s{{index}}"><span class="num">{{index}} / {{sections.length}}</span>{{{content}}}</section>{{/sections}}
<script>addEventListener('keydown',e=>{const s=[...document.querySelectorAll('.slide')];const i=s.findIndex(x=>x.getBoundingClientRect().top>=-5);const d={ArrowRight:1,ArrowDown:1,PageDown:1,' ':1,ArrowLeft:-1,ArrowUp:-1,PageUp:-1}[e.key];if(d){e.preventDefault();s[Math.max(0,Math.min(s.length-1,i+d))]?.scrollIntoView({behavior:'smooth'})}})</script>
{{#mermaid}}<script type="module">import mermaid from '{{{mermaid}}}'; mermaid.initialize({ startOnLoad: true, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });</script>{{/mermaid}}
</body>
</html>
`;

export const DEFAULT_LAYOUTS: Record<string, string> = { default: DEFAULT_LAYOUT, deck: DECK_LAYOUT };

// The default social card (R95), in the default theme's colours, for Satori:
// inline styles, flexbox, and the built-in Inter fonts.
export const DEFAULT_CARD = `<div style="display:flex;flex-direction:column;width:100%;height:100%;box-sizing:border-box;padding:64px 80px;background:#fbfaf7;color:#1d1d1f;font-family:Inter;border-top:14px solid #b4531f">
  <div style="display:flex;font-size:28px;font-weight:700;color:#6b6b70">{{site.title}}</div>
  <div style="display:flex;flex-direction:column;justify-content:center;flex-grow:1">
    <div style="display:block;line-clamp:3;font-size:72px;font-weight:700;line-height:1.1;letter-spacing:-1.5px">{{title}}</div>
    {{#description}}<div style="display:block;line-clamp:2;margin-top:24px;font-size:30px;line-height:1.35;color:#6b6b70">{{description}}</div>{{/description}}
  </div>
  <div style="display:flex;justify-content:space-between;font-size:24px;color:#6b6b70">
    <span>{{#dateLong}}{{dateLong}}{{/dateLong}}</span><span style="color:#b4531f">{{#tags}}#{{name}}  {{/tags}}</span>
  </div>
</div>`;
