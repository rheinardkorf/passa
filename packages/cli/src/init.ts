// passa init: a small starting site that builds and publishes as it is.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const today = () => new Date().toISOString().slice(0, 10);

const FILES: Record<string, () => string> = {
  '_site.yml': () => `title: My site
description: Notes and writing.
# url: https://example.com/   (the site's address, for absolute links and the feed)
nav:
  - { title: Home, url: / }
`,
  'index.md': () => `---
title: Home
access: public
---

# Hello

This site is plain Markdown. Edit \`index.md\`, add pages next to it, and run \`passa serve\` to see them.

Pages are only built when they say \`access: public\` in their front matter, so drafts and private notes stay out of the site until you mark them. (Once the site is published with Passa, its access rules decide instead.)
`,
  'first-post.md': () => `---
title: My first post
date: ${today()}
tags: [hello]
access: public
---

Write in Markdown: **bold**, [links](index.md), wikilinks to other pages by title (like [[Home]]), and tables.

> [!tip] Callouts
> Obsidian-style callouts work too.
`,
};

// Writes the starting files; refuses rather than overwrite anything.
export function initSite(folder: string): string[] {
  const existing = Object.keys(FILES).filter((f) => existsSync(join(folder, f)));
  if (existing.length) throw new Error(`${existing.join(', ')} already exist${existing.length === 1 ? 's' : ''} in ${folder}; nothing was changed`);
  mkdirSync(folder, { recursive: true });
  for (const [name, content] of Object.entries(FILES)) writeFileSync(join(folder, name), content());
  return Object.keys(FILES);
}
