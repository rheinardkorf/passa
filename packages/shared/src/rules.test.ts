import { describe, expect, it } from 'vitest';
import { accessChanges, accessOf, checkRules, edgeRules, MAX_RULES, regions, type Rule, ruleId, servedPath, sharedRulesFor, tierFor } from './rules.ts';

const pub = (path: string): Rule => ({ path, tier: 'public' });
const priv = (path: string): Rule => ({ path, tier: 'private' });

describe('checkRules', () => {
  it('accepts / and folders ending in /', () => {
    expect(checkRules([pub('/'), priv('/notes/'), pub('/a/b-c_d.e~f@g+h/')])).toEqual([]);
    expect(checkRules([])).toEqual([]);
  });

  it('refuses anything else', () => {
    expect(checkRules([
      pub(''),
      pub('docs/'),
      pub('/docs'),
      pub('/docs/index.html'),
      pub('//'),
      pub('/../'),
      pub('/.git/'),
      pub('/a%2F/'),
      pub('/docs/*'),
    ])).toEqual([
      '"": use / or a folder ending in /, such as /docs/',
      '"docs/": use / or a folder ending in /, such as /docs/',
      '"/docs": use / or a folder ending in /, such as /docs/',
      '"/docs/index.html": use / or a folder ending in /, such as /docs/',
      '"//": use / or a folder ending in /, such as /docs/',
      '"/../": use / or a folder ending in /, such as /docs/',
      '"/.git/": use / or a folder ending in /, such as /docs/',
      '"/a%2F/": use / or a folder ending in /, such as /docs/',
      '"/docs/*": use / or a folder ending in /, such as /docs/',
    ]);
  });

  it('refuses /_passa/, duplicates, too many rules and long paths', () => {
    expect(checkRules([pub('/_passa/'), pub('/_passa/x/')])).toEqual(['"/_passa/": /_passa/ is reserved', '"/_passa/x/": /_passa/ is reserved']);
    expect(checkRules([pub('/a/'), priv('/a/')])).toEqual(['"/a/": listed twice']);
    expect(checkRules(Array.from({ length: MAX_RULES + 1 }, (_, i) => pub(`/f${i}/`)))).toEqual([`more than ${MAX_RULES} rules`]);
    expect(checkRules([pub(`/${'a'.repeat(200)}/`)])[0]).toContain('at most 200 characters');
  });

  it('refuses rules too long together for the edge record', () => {
    const long = Array.from({ length: 6 }, (_, i) => pub(`/${String(i).repeat(180)}/`));
    expect(checkRules(long)).toEqual(['the rules are too long together; use fewer or shorter paths']);
  });
});

describe('edgeRules', () => {
  it('sends nothing when nothing is public', () => {
    expect(edgeRules([])).toEqual([]);
    expect(edgeRules([priv('/'), priv('/notes/')])).toEqual([]);
  });

  it('sends every rule, longest first, when something is public', () => {
    expect(edgeRules([pub('/'), priv('/notes/'), pub('/notes/shared/')])).toEqual([['/notes/shared/', 'p'], ['/notes/', 'x'], ['/', 'p']]);
  });
});

describe('tierFor', () => {
  const rules = [pub('/'), priv('/notes/'), pub('/notes/shared/')];

  it('takes the longest matching prefix', () => {
    expect(tierFor(rules, '/index.html')).toBe('public');
    expect(tierFor(rules, '/notes/index.html')).toBe('private');
    expect(tierFor(rules, '/notes/shared/a.png')).toBe('public');
    expect(tierFor(rules, '/notes.html')).toBe('public');
  });

  it('treats anything uncovered as private', () => {
    expect(tierFor([], '/index.html')).toBe('private');
    expect(tierFor([pub('/docs/')], '/index.html')).toBe('private');
    expect(tierFor([pub('/docs/')], '/docs.html')).toBe('private');
  });
});

describe('the shared tier (M5)', () => {
  const shared = (path: string): Rule => ({ path, tier: 'shared' });

  it('sends shared rules to the edge as s, even with nothing public', () => {
    expect(edgeRules([shared('/plans/')])).toEqual([['/plans/', 's', ruleId('/plans/')]]);
    expect(edgeRules([pub('/'), shared('/plans/'), priv('/plans/drafts/')])).toEqual([['/plans/drafts/', 'x'], ['/plans/', 's', ruleId('/plans/')], ['/', 'p']]);
    expect(ruleId('/plans/')).toMatch(/^[0-9a-f]{8}$/);
    expect(ruleId('/plans/')).not.toBe(ruleId('/plans/acme/'));
    expect(edgeRules([priv('/a/')])).toEqual([]);
  });

  it('counts shared regions, and calls an all-shared site shared', () => {
    expect(regions([shared('/plans/')])).toEqual({ public: [], shared: ['/plans/'], private: ['/'] });
    expect(accessOf([shared('/')])).toBe('shared');
    expect(accessOf([shared('/plans/')])).toBe('mixed');
  });

  it('reports what becomes shared, and that shared to private is not public', () => {
    expect(accessChanges([], [shared('/plans/')])).toEqual({ madePublic: [], madeShared: ['/plans/'], madePrivate: [] });
    expect(accessChanges([shared('/')], [])).toEqual({ madePublic: [], madeShared: [], madePrivate: ['/'] });
    expect(accessChanges([shared('/')], [pub('/')]).madePublic).toEqual(['/']);
  });
});

describe('regions and access', () => {
  it('names each region by its prefix', () => {
    expect(regions([])).toEqual({ public: [], shared: [], private: ['/'] });
    expect(regions([pub('/'), priv('/notes/')])).toEqual({ public: ['/'], shared: [], private: ['/notes/'] });
    expect(regions([pub('/docs/')])).toEqual({ public: ['/docs/'], shared: [], private: ['/'] });
  });

  it('summarises a site as private, public or mixed', () => {
    expect(accessOf([])).toBe('private');
    expect(accessOf([priv('/'), priv('/a/')])).toBe('private');
    expect(accessOf([pub('/')])).toBe('public');
    expect(accessOf([pub('/'), pub('/a/')])).toBe('public');
    expect(accessOf([pub('/'), priv('/a/')])).toBe('mixed');
  });
});

describe('accessChanges', () => {
  it('finds what becomes public or private', () => {
    expect(accessChanges([], [pub('/')])).toEqual({ madePublic: ['/'], madeShared: [], madePrivate: [] });
    expect(accessChanges([pub('/')], [])).toEqual({ madePublic: [], madeShared: [], madePrivate: ['/'] });
    expect(accessChanges([pub('/')], [pub('/'), priv('/notes/')])).toEqual({ madePublic: [], madeShared: [], madePrivate: ['/notes/'] });
  });

  it('catches a path exposed by removing a private rule', () => {
    expect(accessChanges([pub('/'), priv('/notes/')], [pub('/')])).toEqual({ madePublic: ['/notes/'], madeShared: [], madePrivate: [] });
  });

  it('sees no change when rules are rewritten without changing access', () => {
    expect(accessChanges([pub('/')], [pub('/'), pub('/docs/')])).toEqual({ madePublic: [], madeShared: [], madePrivate: [] });
    expect(accessChanges([], [priv('/'), priv('/a/')])).toEqual({ madePublic: [], madeShared: [], madePrivate: [] });
  });
});

describe('served paths', () => {
  it('match the edge: folders get index.html, and so do paths without an extension', () => {
    expect(servedPath('/')).toBe('/index.html');
    expect(servedPath('/plans/')).toBe('/plans/index.html');
    expect(servedPath('/plans')).toBe('/plans/index.html');
    expect(servedPath('/plans/q1.pdf')).toBe('/plans/q1.pdf');
  });
});

describe('shares by path (M5)', () => {
  const shared = (path: string): Rule => ({ path, tier: 'shared' });
  const rules = [pub('/'), shared('/proposals/acme/'), shared('/proposals/globex/'), shared('/plans/'), priv('/plans/hr/')];
  it('opens the shared rules at or under each path shared', () => {
    expect(sharedRulesFor(rules, ['/proposals/acme/']).map((r) => r.path)).toEqual(['/proposals/acme/']);
    expect(sharedRulesFor(rules, ['/proposals/']).map((r) => r.path)).toEqual(['/proposals/acme/', '/proposals/globex/']);
    expect(sharedRulesFor(rules, ['/']).map((r) => r.path)).toEqual(['/proposals/acme/', '/proposals/globex/', '/plans/']);
    expect(sharedRulesFor(rules, ['/plans/acme/'])).toEqual([]);
  });
});
