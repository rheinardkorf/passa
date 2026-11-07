// Path rules (M2, M6): who may view which parts of a site. Each rule is a
// folder prefix and its access; the longest matching prefix decides, and a
// path no rule covers is private. Rules are matched against the path the edge serves, after
// index.html is added.
import { createHash } from 'node:crypto';

// M6: a rule's access is a list of audiences (public, or tier names) or
// private, the keyword for closing a path inside a more open folder. Private
// is also the default for a path no rule covers. The owner opens everything.
export type RuleAccess = string[] | 'private';
export type Rule = { path: string; access: RuleAccess };
// Rules as M2–M5 stored them. Only the store reads them, converting sites'
// stored rules until each is next saved in the new form.
export type LegacyRule = { path: string; tier: 'private' | 'public' | 'shared' };

// M5's shared became private: the people it was shared with keep their shares,
// which open the rule at their path (M6 R162).
export const toRule = (r: Rule | LegacyRule): Rule =>
  'access' in r ? r : { path: r.path, access: r.tier === 'public' ? ['public'] : 'private' };

export const isPublicAccess = (access: RuleAccess): boolean => access !== 'private' && access.includes('public');

// The edge form, longest first: p: public; s: restricted, with the rule's ID,
// which a viewer's cookie lists when they may open it. (x, private without an
// ID, is no longer written, and the edge treats it as private.)
export type EdgeRule = [string, 'p' | 'x'] | [string, 's', string];

// A rule's ID: short, stable while the rule's path is, and the same wherever
// it's computed. A collision within one site's 20 rules is a 1 in 4 billion
// chance, and would only open a rule to someone allowed another.
export const ruleId = (path: string): string => createHash('sha256').update(path).digest('hex').slice(0, 8);

// The rules a viewer opens besides public ones (M6 R156, R158): those listing
// one of their tiers, and the rule at each path shared with them.
export function viewerRules(rules: Rule[], grants: { tiers: string[]; sharePaths: string[] }): Rule[] {
  return rules.filter((r) => !isPublicAccess(r.access)
    && ((r.access !== 'private' && r.access.some((a) => grants.tiers.includes(a))) || grants.sharePaths.includes(r.path)));
}

// The rule that decides a served path, if any.
export function ruleFor(rules: Rule[], servedPath: string): Rule | undefined {
  return [...rules].sort(byLength).find((r) => servedPath.startsWith(r.path));
}

export const MAX_RULES = 20;
export const MAX_RULE_PATH = 200;
// KeyValueStore values are limited to 1 KB, and the rest of the edge record
// (current version, access version, a name of up to 40 characters) needs
// about 110 bytes of it.
export const MAX_EDGE_RULES_BYTES = 850;

// "/" or folders ending in "/", from the same characters as publishable paths.
// No dotfile folders, since nothing under them is published.
const RULE_PATH = /^\/(?:[A-Za-z0-9_~@+-][A-Za-z0-9._~@+-]*\/)*$/;

const byLength = (a: Rule, b: Rule) => b.path.length - a.path.length;

// Tier names (M6 R147): short, lowercase, and never a word rules use themselves.
export const TIER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$/;
export const RESERVED_TIERS = ['public', 'private', 'shared'];
export const isTierName = (name: string): boolean => TIER_NAME.test(name) && !RESERVED_TIERS.includes(name);

// What's wrong with one rule's access (M6 R146), or nothing.
function accessProblem(access: unknown): string | undefined {
  if (access === 'private') return undefined;
  if (!Array.isArray(access) || !access.length) return 'access is private, or a list such as [public] or [gold, silver]';
  if (access.includes('public') && access.length > 1) return 'public already opens to everyone, so it isn\'t combined with tiers';
  if (access.includes('private')) return 'private stands alone: it closes a path, and isn\'t combined with anything';
  const bad = access.find((a) => a !== 'public' && !(typeof a === 'string' && isTierName(a)));
  if (bad !== undefined) return `${JSON.stringify(String(bad).slice(0, 40))} isn't a tier name: 1–30 lowercase letters, digits and hyphens, and not public, private or shared`;
  if (new Set(access).size !== access.length) return 'a tier is listed twice';
  return undefined;
}

// Problems with a set of rules, or none.
export function checkRules(rules: Rule[]): string[] {
  const problems: string[] = [];
  if (rules.length > MAX_RULES) problems.push(`more than ${MAX_RULES} rules`);
  const seen = new Set<string>();
  for (const { path, access } of rules) {
    const shown = JSON.stringify(path.slice(0, MAX_RULE_PATH));
    const accessIssue = accessProblem(access);
    if (path.length > MAX_RULE_PATH) problems.push(`${shown}: rule paths must be at most ${MAX_RULE_PATH} characters`);
    else if (!RULE_PATH.test(path)) problems.push(`${shown}: use / or a folder ending in /, such as /docs/`);
    else if (path === '/_passa/' || path.startsWith('/_passa/')) problems.push(`${shown}: /_passa/ is reserved`);
    else if (seen.has(path)) problems.push(`${shown}: listed twice`);
    else if (accessIssue) problems.push(`${shown}: ${accessIssue}`);
    seen.add(path);
  }
  if (!problems.length && new TextEncoder().encode(JSON.stringify(edgeRules(rules))).byteLength > MAX_EDGE_RULES_BYTES) {
    problems.push(`the rules are too long together; use fewer or shorter paths`);
  }
  return problems;
}

// Every rule goes to the edge: public ones as p, the rest with their ID, since
// any of them can be opened by a membership or a share (M6).
export function edgeRules(rules: Rule[]): EdgeRule[] {
  return [...rules].sort(byLength).map((r): EdgeRule => (isPublicAccess(r.access) ? [r.path, 'p'] : [r.path, 's', ruleId(r.path)]));
}

// The file the edge serves for a request path, which rules match: a folder's
// index.html, and /docs as /docs/index.html (the edge's indexPath).
export function servedPath(path: string): string {
  if (path.endsWith('/')) return `${path}index.html`;
  return path.slice(path.lastIndexOf('/') + 1).includes('.') ? path : `${path}/index.html`;
}

// The access of a served path: its rule's, else private.
export function accessFor(rules: Rule[], servedPath: string): RuleAccess {
  return ruleFor(rules, servedPath)?.access ?? 'private';
}

// What a region is, for summaries and for what a change did: open to anyone,
// to members of tiers, or to the owner (and anyone it's shared with).
export type RegionKind = 'public' | 'members' | 'private';
const kindOf = (access: RuleAccess): RegionKind => (access === 'private' ? 'private' : isPublicAccess(access) ? 'public' : 'members');
const sameAccess = (a: RuleAccess, b: RuleAccess) => (a === 'private' || b === 'private' ? a === b : [...a].sort().join() === [...b].sort().join());

// The rules split a site into regions: the paths under a prefix that no longer
// prefix covers. P + "\0" stands for a path directly under P, since "\0" is in
// no published path or rule. Each region is named by its prefix.
const under = (prefix: string) => `${prefix}\0`;
const prefixes = (...sets: Rule[][]) => [...new Set(['/', ...sets.flat().map((r) => r.path)])].sort();

export type Access = RegionKind | 'mixed';

// Which regions are public, for members, and private.
export function regions(rules: Rule[]): Record<RegionKind, string[]> {
  const result: Record<RegionKind, string[]> = { public: [], members: [], private: [] };
  for (const p of prefixes(rules)) result[kindOf(accessFor(rules, under(p)))].push(p);
  return result;
}

// One word for the site: its only kind of region, or mixed.
export function accessOf(rules: Rule[]): Access {
  const r = regions(rules);
  const kinds = (['public', 'members', 'private'] as const).filter((k) => r[k].length);
  return kinds.length === 1 ? kinds[0] ?? 'private' : 'mixed';
}

// What a change of rules makes public, opens to members (or to other tiers),
// or makes private. Checking regions, not rules, catches every way to expose a
// path, such as removing a private rule inside a public folder.
export function accessChanges(before: Rule[], after: Rule[]): { madePublic: string[]; madeMembers: string[]; madePrivate: string[] } {
  const made: Record<RegionKind, string[]> = { public: [], members: [], private: [] };
  for (const p of prefixes(before, after)) {
    const now = accessFor(after, under(p));
    if (!sameAccess(accessFor(before, under(p)), now)) made[kindOf(now)].push(p);
  }
  return { madePublic: made.public, madeMembers: made.members, madePrivate: made.private };
}
