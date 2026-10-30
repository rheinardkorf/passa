// Path rules (M2): who may view which parts of a site. Each rule is a folder
// prefix and a tier; the longest matching prefix decides, and a path no rule
// covers is private. Rules are matched against the path the edge serves, after
// index.html is added.

export type Tier = 'private' | 'public';
export type Rule = { path: string; tier: Tier };

// The edge form: [prefix, tier] pairs, longest first. p: public, x: private.
export type EdgeRule = [string, 'p' | 'x'];

export const MAX_RULES = 20;
export const MAX_RULE_PATH = 200;
// KeyValueStore values are limited to 1 KB, and the rest of the edge record
// (current version, access version) needs about 60 bytes of it.
export const MAX_EDGE_RULES_BYTES = 900;

// "/" or folders ending in "/", from the same characters as publishable paths.
// No dotfile folders, since nothing under them is published.
const RULE_PATH = /^\/(?:[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*\/)*$/;

const byLength = (a: Rule, b: Rule) => b.path.length - a.path.length;

// Problems with a set of rules, or none.
export function checkRules(rules: Rule[]): string[] {
  const problems: string[] = [];
  if (rules.length > MAX_RULES) problems.push(`more than ${MAX_RULES} rules`);
  const seen = new Set<string>();
  for (const { path } of rules) {
    const shown = JSON.stringify(path.slice(0, MAX_RULE_PATH));
    if (path.length > MAX_RULE_PATH) problems.push(`${shown}: rule paths must be at most ${MAX_RULE_PATH} characters`);
    else if (!RULE_PATH.test(path)) problems.push(`${shown}: use / or a folder ending in /, such as /docs/`);
    else if (path === '/_passa/' || path.startsWith('/_passa/')) problems.push(`${shown}: /_passa/ is reserved`);
    else if (seen.has(path)) problems.push(`${shown}: listed twice`);
    seen.add(path);
  }
  if (!problems.length && new TextEncoder().encode(JSON.stringify(edgeRules(rules))).byteLength > MAX_EDGE_RULES_BYTES) {
    problems.push(`the rules are too long together; use fewer or shorter paths`);
  }
  return problems;
}

// Only rules that can make something public are worth sending to the edge:
// without a public rule, everything is private anyway.
export function edgeRules(rules: Rule[]): EdgeRule[] {
  if (!rules.some((r) => r.tier === 'public')) return [];
  return [...rules].sort(byLength).map((r) => [r.path, r.tier === 'public' ? 'p' : 'x']);
}

// The tier for a served path, as the edge decides it.
export function tierFor(rules: Rule[], servedPath: string): Tier {
  return [...rules].sort(byLength).find((r) => servedPath.startsWith(r.path))?.tier ?? 'private';
}

// The rules split a site into regions: the paths under a prefix that no longer
// prefix covers. P + "\0" stands for a path directly under P, since "\0" is in
// no published path or rule. Each region is named by its prefix.
const under = (prefix: string) => `${prefix}\0`;
const prefixes = (...sets: Rule[][]) => [...new Set(['/', ...sets.flat().map((r) => r.path)])].sort();

export type Access = 'private' | 'public' | 'mixed';

// Which regions are public and which private.
export function regions(rules: Rule[]): { public: string[]; private: string[] } {
  const result = { public: [] as string[], private: [] as string[] };
  for (const p of prefixes(rules)) result[tierFor(rules, under(p))].push(p);
  return result;
}

export function accessOf(rules: Rule[]): Access {
  const { public: open, private: closed } = regions(rules);
  return !open.length ? 'private' : closed.length ? 'mixed' : 'public';
}

// What a change of rules makes public or private. Checking regions, not
// rules, catches every way to expose a path, such as removing a private rule
// inside a public folder.
export function accessChanges(before: Rule[], after: Rule[]): { madePublic: string[]; madePrivate: string[] } {
  const madePublic: string[] = [];
  const madePrivate: string[] = [];
  for (const p of prefixes(before, after)) {
    const was = tierFor(before, under(p));
    const now = tierFor(after, under(p));
    if (was !== now) (now === 'public' ? madePublic : madePrivate).push(p);
  }
  return { madePublic, madePrivate };
}
