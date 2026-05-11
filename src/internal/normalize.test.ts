import { describe, expect, it } from 'vitest';
import { nullsToUndefined } from './normalize.js';

describe('nullsToUndefined', () => {
  it('replaces top-level null values with undefined', () => {
    expect(nullsToUndefined({ a: 1, b: null })).toEqual({
      a: 1,
      b: undefined,
    });
  });

  it('leaves non-null values alone', () => {
    expect(nullsToUndefined({ a: 0, b: '', c: false, d: undefined })).toEqual(
      { a: 0, b: '', c: false, d: undefined },
    );
  });

  it('does not recurse into nested objects (JSON columns intact)', () => {
    expect(nullsToUndefined({ meta: { foo: null, bar: 1 } })).toEqual({
      meta: { foo: null, bar: 1 },
    });
  });

  it('does not recurse into arrays', () => {
    expect(nullsToUndefined({ tags: [null, 'a'] })).toEqual({
      tags: [null, 'a'],
    });
  });

  it('preserves Date instances', () => {
    const d = new Date('2024-01-01');
    const out = nullsToUndefined({ created: d });
    expect(out.created).toBe(d);
  });

  it('returns primitives unchanged', () => {
    expect(nullsToUndefined(42)).toBe(42);
    expect(nullsToUndefined('hi')).toBe('hi');
    expect(nullsToUndefined(null)).toBe(null);
  });
});
