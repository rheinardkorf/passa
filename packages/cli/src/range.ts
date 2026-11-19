// Byte ranges for passa serve (RFC 9110 §14). Safari asks for video in
// ranges, starting with bytes=0-1, and won't play it from a server that
// answers with the whole file. Only single ranges are supported: for a list of
// ranges the whole file is sent, which the RFC allows.

export type ByteRange = { start: number; end: number }; // inclusive

/**
 * The range a Range header asks for in a file of `size` bytes: a range to send
 * with 206, 'unsatisfiable' for a 416, or undefined to send the whole file
 * with 200 (no header, one Passa doesn't support, or one it may ignore).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return undefined;
  if (first === '') {
    // bytes=-N: the last N bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== '' && Number(last) < start) return undefined; // invalid: ignore the header
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}
