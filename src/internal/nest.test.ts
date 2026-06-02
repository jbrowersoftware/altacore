import { describe, expect, it } from 'vitest';
import { assertJoinColumns, nestJoinedRow } from './nest.js';
import type { AnyJoin, DbCore } from '../core/dbCore.js';

// Minimal DbCore stand-in for tests — the nester only reads .alias/.type/
// .select from JoinSpec, and never touches .table beyond carrying it through.
const stubTable = (name: string) => ({ tableName: name }) as unknown as DbCore<unknown>;

function joinSpec(spec: {
  alias: string;
  type?: 'inner' | 'left' | 'right' | 'full';
  columns?: readonly string[];
  nested?: AnyJoin<unknown> | readonly AnyJoin<unknown>[];
}): AnyJoin<unknown> {
  return {
    table: stubTable(spec.alias),
    alias: spec.alias,
    type: spec.type,
    on: ['id', 'id'] as readonly [string, string],
    select: { columns: spec.columns, join: spec.nested },
  } as AnyJoin<unknown>;
}

describe('nestJoinedRow', () => {
  it('returns the row unchanged when there are no joins', () => {
    const row = { id: 1, name: 'A' };
    expect(nestJoinedRow(row, undefined)).toBe(row);
  });

  it('nests a single inner join under its alias', () => {
    const row = { id: 1, name: 'A', 'o.id': 10, 'o.total': 100 };
    const out = nestJoinedRow(
      row,
      joinSpec({ alias: 'o', columns: ['id', 'total'] }),
    );
    expect(out).toEqual({ id: 1, name: 'A', o: { id: 10, total: 100 } });
  });

  it('sets the slot to undefined for a LEFT join with no match', () => {
    const row = {
      id: 3,
      name: 'Carol',
      'o.id': undefined,
      'o.total': undefined,
    };
    const out = nestJoinedRow(
      row,
      joinSpec({ alias: 'o', type: 'left', columns: ['id', 'total'] }),
    );
    expect(out).toEqual({ id: 3, name: 'Carol', o: undefined });
  });

  it('keeps a LEFT-joined object when at least one column has a value', () => {
    const row = { id: 1, name: 'A', 'o.id': 10, 'o.total': undefined };
    const out = nestJoinedRow(
      row,
      joinSpec({ alias: 'o', type: 'left', columns: ['id', 'total'] }),
    );
    expect(out).toEqual({ id: 1, name: 'A', o: { id: 10, total: undefined } });
  });

  it('nests parallel joins under their respective aliases', () => {
    const row = {
      id: 1,
      'o.id': 10,
      'o.total': 100,
      'i.id': 50,
      'i.sku': 'X',
    };
    const out = nestJoinedRow(row, [
      joinSpec({ alias: 'o', columns: ['id', 'total'] }),
      joinSpec({ alias: 'i', columns: ['id', 'sku'] }),
    ]);
    expect(out).toEqual({
      id: 1,
      o: { id: 10, total: 100 },
      i: { id: 50, sku: 'X' },
    });
  });

  it('recurses into nested joins', () => {
    const row = {
      id: 1,
      name: 'A',
      'o.id': 10,
      'o.total': 100,
      'o.it.id': 100,
      'o.it.sku': 'X',
    };
    const out = nestJoinedRow(
      row,
      joinSpec({
        alias: 'o',
        columns: ['id', 'total'],
        nested: joinSpec({ alias: 'it', columns: ['id', 'sku'] }),
      }),
    );
    expect(out).toEqual({
      id: 1,
      name: 'A',
      o: { id: 10, total: 100, it: { id: 100, sku: 'X' } },
    });
  });

  it('marks a nested LEFT join undefined when its leaves are all undefined', () => {
    const row = {
      id: 1,
      'o.id': 10,
      'o.total': 100,
      'o.it.id': undefined,
      'o.it.sku': undefined,
    };
    const out = nestJoinedRow(
      row,
      joinSpec({
        alias: 'o',
        columns: ['id', 'total'],
        nested: joinSpec({
          alias: 'it',
          type: 'left',
          columns: ['id', 'sku'],
        }),
      }),
    );
    expect(out).toEqual({
      id: 1,
      o: { id: 10, total: 100, it: undefined },
    });
  });

  it('treats a parent LEFT as undefined when all leaves (including nested) are undefined', () => {
    const row = {
      id: 1,
      'o.id': undefined,
      'o.total': undefined,
      'o.it.id': undefined,
      'o.it.sku': undefined,
    };
    const out = nestJoinedRow(
      row,
      joinSpec({
        alias: 'o',
        type: 'left',
        columns: ['id', 'total'],
        nested: joinSpec({ alias: 'it', columns: ['id', 'sku'] }),
      }),
    );
    expect(out).toEqual({ id: 1, o: undefined });
  });
});

describe('assertJoinColumns', () => {
  it('passes when every join has columns', () => {
    expect(() =>
      assertJoinColumns(joinSpec({ alias: 'o', columns: ['id'] })),
    ).not.toThrow();
  });

  it('throws when a top-level join is missing columns', () => {
    expect(() => assertJoinColumns(joinSpec({ alias: 'o' }))).toThrow(
      /Missing or empty columns on alias "o"/,
    );
  });

  it('throws when columns is an empty array', () => {
    expect(() =>
      assertJoinColumns(joinSpec({ alias: 'o', columns: [] })),
    ).toThrow(/Missing or empty columns on alias "o"/);
  });

  it('throws when a nested join is missing columns', () => {
    expect(() =>
      assertJoinColumns(
        joinSpec({
          alias: 'o',
          columns: ['id'],
          nested: joinSpec({ alias: 'it' }),
        }),
      ),
    ).toThrow(/Missing or empty columns on alias "it"/);
  });

  it('accepts no joins at all', () => {
    expect(() => assertJoinColumns(undefined)).not.toThrow();
  });
});
