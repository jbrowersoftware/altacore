import { describe, expect, it } from 'vitest';
import {
  hydrateRows,
  resolveHydration,
  type HydrationSpecRuntime,
  type ResolvedHydration,
} from './hydrate.js';

type AnyRow = Record<string, unknown>;

// Minimal structural stand-in for the resolved DbCore — hydrateRows only
// calls `select({ where })`.
function fakeTable(rows: AnyRow[]): {
  table: ResolvedHydration['table'];
  selects: unknown[];
} {
  const selects: unknown[] = [];
  const table = {
    tableName: 'fake',
    select: (options?: unknown) => {
      selects.push(options);
      return Promise.resolve(rows);
    },
  } as unknown as ResolvedHydration['table'];
  return { table, selects };
}

describe('resolveHydration', () => {
  const orgs = fakeTable([]).table;
  const spec: HydrationSpecRuntime = {
    org: { table: orgs, on: ['orgId', 'id'] },
  };

  it('returns [] for undefined or empty keys', () => {
    expect(resolveHydration('users', undefined, spec, undefined)).toEqual([]);
    expect(resolveHydration('users', [], spec, undefined)).toEqual([]);
  });

  it('throws when the key has no configured relation', () => {
    expect(() => resolveHydration('users', ['bogus'], spec, undefined)).toThrow(
      /hydrate key "bogus" has no relation configured/,
    );
    expect(() =>
      resolveHydration('users', ['org'], undefined, undefined),
    ).toThrow(/hydrate key "org" has no relation configured/);
  });

  it('throws when a columns projection drops the FK column', () => {
    expect(() =>
      resolveHydration('users', ['org'], spec, ['id', 'email']),
    ).toThrow(/FK column "orgId", which is not in 'columns'/);
  });

  it('accepts a columns projection that keeps the FK column', () => {
    const out = resolveHydration('users', ['org'], spec, ['id', 'orgId']);
    expect(out).toEqual([
      { key: 'org', table: orgs, fkCol: 'orgId', refCol: 'id' },
    ]);
  });

  it('collapses duplicate keys to the first occurrence', () => {
    const out = resolveHydration('users', ['org', 'org'], spec, undefined);
    expect(out).toHaveLength(1);
  });

  it('resolves table thunks at call time', () => {
    const lazySpec: HydrationSpecRuntime = {
      org: { table: () => orgs, on: ['orgId', 'id'] },
    };
    const out = resolveHydration('users', ['org'], lazySpec, undefined);
    expect(out[0]?.table).toBe(orgs);
  });
});

describe('hydrateRows', () => {
  it('grafts matches in place, batching distinct non-null FK values', async () => {
    const orgA = { id: 10, name: 'A' };
    const orgB = { id: 11, name: 'B' };
    const { table, selects } = fakeTable([orgA, orgB]);
    const rows: AnyRow[] = [
      { id: 1, orgId: 10 },
      { id: 2, orgId: 11 },
      { id: 3, orgId: 10 }, // duplicate FK — deduped in the lookup
      { id: 4, orgId: undefined }, // NULL FK — skipped
      { id: 5, orgId: 99 }, // no match — left absent
    ];

    await hydrateRows(rows, [
      { key: 'org', table, fkCol: 'orgId', refCol: 'id' },
    ]);

    expect(selects).toEqual([{ where: { id: { in: [10, 11, 99] } } }]);
    expect(rows[0]?.org).toEqual(orgA);
    expect(rows[1]?.org).toEqual(orgB);
    // Rows sharing an FK share the same related object.
    expect(rows[2]?.org).toBe(rows[0]?.org);
    expect('org' in (rows[3] ?? {})).toBe(false);
    expect('org' in (rows[4] ?? {})).toBe(false);
  });

  it('skips the lookup entirely when every FK is null/absent', async () => {
    const { table, selects } = fakeTable([]);
    const rows: AnyRow[] = [{ id: 1, orgId: undefined }, { id: 2 }];

    await hydrateRows(rows, [
      { key: 'org', table, fkCol: 'orgId', refCol: 'id' },
    ]);

    expect(selects).toHaveLength(0);
    expect('org' in (rows[0] ?? {})).toBe(false);
  });

  it('does nothing for empty rows or relations', async () => {
    const { table, selects } = fakeTable([]);
    await hydrateRows(
      [],
      [{ key: 'org', table, fkCol: 'orgId', refCol: 'id' }],
    );
    await hydrateRows([{ id: 1 }], []);
    expect(selects).toHaveLength(0);
  });

  it('throws when a hydration key collides with an existing row property', async () => {
    const { table, selects } = fakeTable([]);
    const rows: AnyRow[] = [{ id: 1, org: 'a column literally named org' }];

    await expect(
      hydrateRows(rows, [{ key: 'org', table, fkCol: 'orgId', refCol: 'id' }]),
    ).rejects.toThrow(/hydrate key "org" collides/);
    // Collision is detected before any lookup runs.
    expect(selects).toHaveLength(0);
  });

  it('hydrates multiple relations independently', async () => {
    const orgs = fakeTable([{ id: 10, name: 'A' }]);
    const managers = fakeTable([{ id: 7, email: 'boss@x.com' }]);
    const rows: AnyRow[] = [{ id: 1, orgId: 10, managerId: 7 }];

    await hydrateRows(rows, [
      { key: 'org', table: orgs.table, fkCol: 'orgId', refCol: 'id' },
      {
        key: 'manager',
        table: managers.table,
        fkCol: 'managerId',
        refCol: 'id',
      },
    ]);

    expect(rows[0]?.org).toEqual({ id: 10, name: 'A' });
    expect(rows[0]?.manager).toEqual({ id: 7, email: 'boss@x.com' });
  });
});
