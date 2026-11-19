import { describe, expect, it } from 'vitest';
import { parseRange } from './range.ts';

describe('parseRange', () => {
  it('reads a range, an open-ended range and a suffix', () => {
    expect(parseRange('bytes=0-1', 1000)).toEqual({ start: 0, end: 1 }); // Safari's first request
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('clamps to the end of the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('refuses a range that starts past the end, or an empty suffix', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('sends the whole file for no header, other units, lists of ranges and invalid ranges', () => {
    expect(parseRange(undefined, 1000)).toBeUndefined();
    expect(parseRange('items=0-1', 1000)).toBeUndefined();
    expect(parseRange('bytes=0-1, 5-6', 1000)).toBeUndefined();
    expect(parseRange('bytes=5-1', 1000)).toBeUndefined();
    expect(parseRange('bytes=-', 1000)).toBeUndefined();
  });
});
