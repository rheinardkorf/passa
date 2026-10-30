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
