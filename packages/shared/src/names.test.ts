import { describe, expect, it } from 'vitest';
import { newSiteId } from './ids.ts';
import { isName, nameProblem } from './names.ts';

describe('nameProblem', () => {
  it('accepts short labels with single hyphens', () => {
    for (const name of ['cv', 'my-cv', 'rheinard-korf-cv', 'q4-report', '2026', 'a'.repeat(40)]) expect(nameProblem(name, []), name).toBeUndefined();
  });

  it('refuses bad shapes, site IDs and reserved names', () => {
    const shape = 'Use 2–40 lowercase letters, digits and single hyphens, not starting or ending with a hyphen.';
    for (const name of ['a', 'a'.repeat(41), '-cv1', 'cv1-', 'my--cv', 'xn--abc', 'My-CV', 'my_cv', 'my.cv', 'café']) expect(nameProblem(name, []), name).toBe(shape);
    expect(nameProblem(newSiteId(), [])).toBe('That looks like a site ID. Choose a name that doesn\'t.');
    expect(nameProblem('www', [])).toBe('That name is reserved.');
    expect(nameProblem('blog', ['blog'])).toBe('That name is reserved.');
  });

  it('never accepts something that is a site ID, so the edge can tell them apart', () => {
    for (let i = 0; i < 500; i++) expect(isName(newSiteId())).toBe(false);
  });
});
