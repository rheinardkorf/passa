import { describe, expect, it } from 'vitest';
import { accessChanges, accessFor, accessOf, checkRules, edgeRules, isTierName, MAX_RULES, regions, type Rule, ruleId, servedPath, toRule, viewerRules } from './rules.ts';

const pub = (path: string): Rule => ({ path, access: ['public'] });
const priv = (path: string): Rule => ({ path, access: 'private' });
const tiers = (path: string, ...names: string[]): Rule => ({ path, access: names });

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

  it('takes [public], tier lists and private, and refuses mixing them (M6 R146, R147)', () => {
    expect(checkRules([pub('/'), tiers('/lessons/', 'gold', 'silver'), priv('/lessons/draft/')])).toEqual([]);
    expect(checkRules([tiers('/a/', 'public', 'gold')])).toEqual(['"/a/": public already opens to everyone, so it isn\'t combined with tiers']);
    expect(checkRules([{ path: '/a/', access: ['private', 'gold'] }])).toEqual(['"/a/": private stands alone: it closes a path, and isn\'t combined with anything']);
    expect(checkRules([tiers('/a/')])[0]).toContain('access is private, or a list');
    expect(checkRules([tiers('/a/', 'Gold')])[0]).toContain('"Gold" isn\'t a tier name');
    expect(checkRules([tiers('/a/', 'shared')])[0]).toContain('isn\'t a tier name');
    expect(checkRules([tiers('/a/', 'gold', 'gold')])).toEqual(['"/a/": a tier is listed twice']);
    expect([isTierName('gold'), isTierName('vip-2026'), isTierName('-x'), isTierName('a'.repeat(31)), isTierName('private')]).toEqual([true, true, false, false, false]);
  });

  it('refuses rules too long together for the edge record', () => {
    const long = Array.from({ length: 6 }, (_, i) => pub(`/${String(i).repeat(180)}/`));
    expect(checkRules(long)).toEqual(['the rules are too long together; use fewer or shorter paths']);
  });
});

describe('edgeRules', () => {
  it('sends every rule, longest first: public as p, the rest with their ID (M6)', () => {
    expect(edgeRules([])).toEqual([]);
    expect(edgeRules([pub('/'), tiers('/lessons/', 'gold'), priv('/lessons/draft/')])).toEqual([
      ['/lessons/draft/', 's', ruleId('/lessons/draft/')], ['/lessons/', 's', ruleId('/lessons/')], ['/', 'p'],
    ]);
    // A private rule goes too, since a share may open it.
    expect(edgeRules([priv('/plans/')])).toEqual([['/plans/', 's', ruleId('/plans/')]]);
    expect(ruleId('/plans/')).toMatch(/^[0-9a-f]{8}$/);
    expect(ruleId('/plans/')).not.toBe(ruleId('/plans/acme/'));
  });
});

describe('access for a path', () => {
  const rules = [pub('/'), tiers('/lessons/', 'gold', 'silver'), priv('/lessons/draft/')];
  it('is the longest matching rule\'s, else private', () => {
    expect(accessFor(rules, '/index.html')).toEqual(['public']);
    expect(accessFor(rules, '/lessons/week-1/index.html')).toEqual(['gold', 'silver']);
    expect(accessFor(rules, '/lessons/draft/index.html')).toBe('private');
    expect(accessFor([], '/x/index.html')).toBe('private');
  });
});

describe('what a viewer opens (M6 R156)', () => {
  const rules = [pub('/'), tiers('/lessons/', 'gold', 'silver'), tiers('/lessons/bonus/', 'gold'), priv('/lessons/draft/')];
  it('opens rules listing one of their tiers, and the rule at each path shared with them', () => {
    expect(viewerRules(rules, { tiers: ['gold'], sharePaths: [] }).map((r) => r.path)).toEqual(['/lessons/', '/lessons/bonus/']);
    expect(viewerRules(rules, { tiers: ['silver'], sharePaths: [] }).map((r) => r.path)).toEqual(['/lessons/']);
    // A share opens exactly its rule: not the bonus under it, whatever the tiers.
    expect(viewerRules(rules, { tiers: [], sharePaths: ['/lessons/'] }).map((r) => r.path)).toEqual(['/lessons/']);
    expect(viewerRules(rules, { tiers: [], sharePaths: ['/lessons/draft/'] }).map((r) => r.path)).toEqual(['/lessons/draft/']);
    expect(viewerRules(rules, { tiers: [], sharePaths: [] })).toEqual([]);
  });
});

describe('regions and access', () => {
  it('splits a site into public, members and private regions, in one word', () => {
    const rules = [pub('/'), tiers('/lessons/', 'gold'), priv('/lessons/draft/')];
    expect(regions(rules)).toEqual({ public: ['/'], members: ['/lessons/'], private: ['/lessons/draft/'] });
    expect([accessOf(rules), accessOf([]), accessOf([pub('/')]), accessOf([tiers('/', 'gold')])]).toEqual(['mixed', 'private', 'public', 'members']);
  });
});

describe('accessChanges', () => {
  it('names what was made public, opened to members (or other tiers), or made private', () => {
    expect(accessChanges([], [pub('/')])).toEqual({ madePublic: ['/'], madeMembers: [], madePrivate: [] });
    expect(accessChanges([pub('/')], [pub('/'), tiers('/docs/', 'gold')])).toEqual({ madePublic: [], madeMembers: ['/docs/'], madePrivate: [] });
    expect(accessChanges([tiers('/docs/', 'gold')], [tiers('/docs/', 'gold', 'silver')])).toEqual({ madePublic: [], madeMembers: ['/docs/'], madePrivate: [] });
    expect(accessChanges([pub('/')], [])).toEqual({ madePublic: [], madeMembers: [], madePrivate: ['/'] });
  });

  it('catches a path exposed by removing a rule inside a public folder', () => {
    expect(accessChanges([pub('/'), priv('/notes/')], [pub('/')])).toEqual({ madePublic: ['/notes/'], madeMembers: [], madePrivate: [] });
  });

  it('sees no change when rules are rewritten without changing access', () => {
    expect(accessChanges([tiers('/a/', 'gold', 'silver')], [tiers('/a/', 'silver', 'gold')])).toEqual({ madePublic: [], madeMembers: [], madePrivate: [] });
    expect(accessChanges([], [priv('/'), priv('/a/')])).toEqual({ madePublic: [], madeMembers: [], madePrivate: [] });
  });
});

describe('rules stored before M6', () => {
  it('read in the new form: public stays public; private and shared become private', () => {
    expect([toRule({ path: '/', tier: 'public' }), toRule({ path: '/a/', tier: 'shared' }), toRule({ path: '/b/', tier: 'private' }), toRule(pub('/c/'))])
      .toEqual([pub('/'), priv('/a/'), priv('/b/'), pub('/c/')]);
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
