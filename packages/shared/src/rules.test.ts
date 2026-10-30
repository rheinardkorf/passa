import { describe, expect, it } from 'vitest';
import { checkRules, edgeRules, MAX_RULES, type Rule, tierFor } from './rules.ts';

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
