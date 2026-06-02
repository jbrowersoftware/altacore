import { describe, expect, it } from 'vitest';
import { createDbCore } from './dbCore.js';
import type { Database, DatabaseDriver } from './database.js';
import type { Driver, QueryResult } from '../drivers/types.js';
import { mysqlDialect, pgDialect } from '../internal/dialect.js';
import type { SqlDialect } from '../internal/where.js';

type Captured = { sql: string; params: unknown[] };

function makeFakeDb(
  rows: unknown[] = [],
  rowCount = 0,
  dialect: SqlDialect = pgDialect,
  kind: DatabaseDriver = 'pg',
): { db: Database; calls: Captured[] } {
  const calls: Captured[] = [];
  const driver: Driver = {
    kind,
    dialect,
    query<R>(sql: string, params: readonly unknown[]): Promise<QueryResult<R>> {
      calls.push({ sql, params: [...params] });
      return Promise.resolve({ rows: rows as R[], rowCount });
    },
    async close() {},
  };
  return { db: { driver }, calls };
}

type Row = { id: number; name: string; age: number; active: boolean };

describe('createDbCore', () => {
  it('select composes SELECT and forwards rows', async () => {
    const { db, calls } = makeFakeDb([{ id: 1, name: 'a', age: 30 }], 1);
    const things = createDbCore<Row>(db, 'things');

    const out = await things.select({
      where: { age: { gt: 18 } },
      limit: 5,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe(
      'SELECT * FROM "things" WHERE "age" > $1 LIMIT 5',
    );
    expect(calls[0]?.params).toEqual([18]);
    expect(out).toEqual([{ id: 1, name: 'a', age: 30 }]);
  });

  it('select with columns narrows the row shape and projects in SQL', async () => {
    const { db, calls } = makeFakeDb([{ id: 1, name: 'a' }], 1);
    const things = createDbCore<Row>(db, 'things');

    const out = await things.select({ columns: ['id', 'name'] });

    expect(calls[0]?.sql).toBe('SELECT "id", "name" FROM "things"');
    // Type-level: out is Pick<Row, 'id' | 'name'>[] — `age` is not on the row.
    expect(out).toEqual([{ id: 1, name: 'a' }]);
    // @ts-expect-error projected rows do not include unselected columns
    void out[0]?.age;
  });

  it('insert composes INSERT with RETURNING and returns the first row (pg)', async () => {
    const { db, calls } = makeFakeDb([{ id: 1, name: 'a', age: 30 }], 1);
    const things = createDbCore<Row>(db, 'things');

    const out = await things.insert({ name: 'a', age: 30 });

    expect(calls[0]?.sql).toBe(
      'INSERT INTO "things" ("name", "age") VALUES ($1, $2) RETURNING *',
    );
    expect(calls[0]?.params).toEqual(['a', 30]);
    // First row from RETURNING reflects DB-applied defaults (e.g. id=1).
    expect(out).toEqual({ id: 1, name: 'a', age: 30 });
  });

  it('update composes UPDATE with RETURNING and returns post-state rows (pg)', async () => {
    const { db, calls } = makeFakeDb([{ id: 1, name: 'b', age: 31 }], 1);
    const things = createDbCore<Row>(db, 'things');

    const out = await things.update({
      set: { name: 'b', age: 31 },
      where: { id: 1 },
    });

    expect(calls[0]?.sql).toBe(
      'UPDATE "things" SET "name" = $1, "age" = $2 WHERE "id" = $3 RETURNING *',
    );
    expect(calls[0]?.params).toEqual(['b', 31, 1]);
    expect(out).toEqual([{ id: 1, name: 'b', age: 31 }]);
  });

  it('count composes SELECT COUNT(*) and returns a number', async () => {
    const { db, calls } = makeFakeDb([{ count: 7 }], 1);
    const things = createDbCore<Row>(db, 'things');

    const n = await things.count({ where: { age: { gt: 18 } } });

    expect(calls[0]?.sql).toBe(
      'SELECT COUNT(*) AS count FROM "things" WHERE "age" > $1',
    );
    expect(calls[0]?.params).toEqual([18]);
    expect(n).toBe(7);
  });

  it('count coerces pg bigint-string results to a number', async () => {
    const { db } = makeFakeDb([{ count: '42' }], 1);
    const things = createDbCore<Row>(db, 'things');

    const n = await things.count();

    expect(n).toBe(42);
  });

  it('count works with no options (no WHERE clause)', async () => {
    const { db, calls } = makeFakeDb([{ count: 3 }], 1);
    const things = createDbCore<Row>(db, 'things');

    const n = await things.count();

    expect(calls[0]?.sql).toBe('SELECT COUNT(*) AS count FROM "things"');
    expect(calls[0]?.params).toEqual([]);
    expect(n).toBe(3);
  });

  it('delete composes DELETE and returns rowCount', async () => {
    const { db, calls } = makeFakeDb([], 3);
    const things = createDbCore<Row>(db, 'things');

    const n = await things.delete({ where: { id: 1 } });

    expect(calls[0]?.sql).toBe('DELETE FROM "things" WHERE "id" = $1');
    expect(calls[0]?.params).toEqual([1]);
    expect(n).toBe(3);
  });

  it('insert echoes input and emits no RETURNING on mysql', async () => {
    const { db, calls } = makeFakeDb([], 1, mysqlDialect, 'mysql');
    const things = createDbCore<Row>(db, 'things');

    const out = await things.insert({ id: 1, name: 'a', age: 30 });

    expect(calls[0]?.sql).toBe(
      'INSERT INTO `things` (`id`, `name`, `age`) VALUES (?, ?, ?)',
    );
    // mysql has no native RETURNING — we echo the input.
    expect(out).toEqual({ id: 1, name: 'a', age: 30 });
  });

  it('update returns [] and emits no RETURNING on mysql', async () => {
    const { db, calls } = makeFakeDb([], 1, mysqlDialect, 'mysql');
    const things = createDbCore<Row>(db, 'things');

    const out = await things.update({
      set: { name: 'b' },
      where: { id: 1 },
    });

    expect(calls[0]?.sql).toBe('UPDATE `things` SET `name` = ? WHERE `id` = ?');
    expect(out).toEqual([]);
  });

  it('select with a single join nests joined columns under the alias', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db, calls } = makeFakeDb(
      [
        { id: 1, name: 'A', age: 30, 'o.id': 10, 'o.total': 100 },
        { id: 2, name: 'B', age: 31, 'o.id': 12, 'o.total': 200 },
      ],
      2,
    );
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    const out = await things.select({
      columns: ['id', 'name'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id', 'total'] },
      },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT "things"."id", "things"."name", "o"."id" AS "o.id", "o"."total" AS "o.total" ' +
        'FROM "things" ' +
        'INNER JOIN "orders" AS "o" ON "things"."id" = "o"."userId"',
    );
    expect(out).toEqual([
      { id: 1, name: 'A', age: 30, o: { id: 10, total: 100 } },
      { id: 2, name: 'B', age: 31, o: { id: 12, total: 200 } },
    ]);
  });

  it('select() accepts qualified orderBy/groupBy refs against the join alias', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db, calls } = makeFakeDb([], 0);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    await things.select({
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id', 'total'] },
      },
      // `o` is a known alias and `total` a known column on it — type-checks.
      orderBy: [
        { alias: 'o', col: 'total', direction: 'desc' },
        { col: 'name' },
      ],
      groupBy: { alias: 'o', col: 'total' },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT "things"."id", "o"."id" AS "o.id", "o"."total" AS "o.total" ' +
        'FROM "things" ' +
        'INNER JOIN "orders" AS "o" ON "things"."id" = "o"."userId" ' +
        'GROUP BY "o"."total" ' +
        'ORDER BY "o"."total" DESC, "things"."name" ASC',
    );
  });

  it('select() with aggregates: emits SQL, coerces numeric outputs, types keys', async () => {
    // pg returns COUNT/SUM as bigint/numeric strings — verify coercion.
    const { db, calls } = makeFakeDb(
      [{ active: true, n: '5', distinctAges: '3' }],
      1,
    );
    const things = createDbCore<Row>(db, 'things');

    const out = await things.select({
      columns: ['active'],
      groupBy: { col: 'active' },
      aggregates: [
        { fn: 'count', arg: '*', as: 'n' },
        {
          fn: 'count',
          arg: { col: 'age' },
          distinct: true,
          as: 'distinctAges',
        },
      ],
    });

    expect(calls[0]?.sql).toBe(
      'SELECT "active", COUNT(*) AS "n", COUNT(DISTINCT "age") AS "distinctAges" ' +
        'FROM "things" GROUP BY "active"',
    );
    // String aggregate outputs are coerced to numbers.
    expect(out[0]?.n).toBe(5);
    expect(out[0]?.distinctAges).toBe(3);
    // Type-level: each `as` key is present and typed `number`.
    const n: number = out[0]!.n;
    const d: number = out[0]!.distinctAges;
    expect(n + d).toBe(8);
  });

  it('select() filters with a correlated EXISTS subquery', async () => {
    type Order = { id: number; userId: number; status: string };
    const { db, calls } = makeFakeDb([], 0);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    await things.select({
      where: {
        active: true,
        exists: {
          table: orders,
          on: ['id', 'userId'],
          where: { status: 'paid' },
        },
      },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT * FROM "things" WHERE "active" = $1 AND EXISTS ' +
        '(SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "things"."id" ' +
        'AND "_ex0"."status" = $2)',
    );
    expect(calls[0]?.params).toEqual([true, 'paid']);
  });

  it('select() composes STRING_AGG + EXISTS + nullable keyset (users/list shape)', async () => {
    type Role = { id: number; userId: number; name: string };
    type Audit = { id: number; userId: number };
    const { db, calls } = makeFakeDb(
      [{ id: 1, name: 'Ann', roles: 'admin,ops' }],
      1,
    );
    const users = createDbCore<Row>(db, 'users');
    const roles = createDbCore<Role>(db, 'roles');
    const audits = createDbCore<Audit>(db, 'audits');

    const out = await users.select({
      columns: ['id', 'name'],
      // LEFT join purely to aggregate roles.name — it projects nothing, so
      // it doesn't need to appear in GROUP BY.
      join: {
        table: roles,
        type: 'left',
        alias: 'r',
        on: ['id', 'userId'],
      },
      aggregates: [
        {
          fn: 'stringAgg',
          arg: { alias: 'r', col: 'name' },
          separator: ',',
          as: 'roles',
        },
      ],
      where: { exists: { table: audits, on: ['id', 'userId'] } },
      groupBy: [{ col: 'id' }, { col: 'name' }],
      keyset: {
        keys: [
          { expr: { coalesce: [{ col: 'name' }, ''] }, direction: 'asc' },
          { expr: { col: 'id' }, direction: 'asc' },
        ],
        after: ['M', 0],
        limit: 50,
      },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT "users"."id", "users"."name", STRING_AGG("r"."name", $1) AS "roles" ' +
        'FROM "users" LEFT JOIN "roles" AS "r" ON "users"."id" = "r"."userId" ' +
        'WHERE EXISTS (SELECT 1 FROM "audits" AS "_ex0" WHERE "_ex0"."userId" = "users"."id") ' +
        'AND (COALESCE("users"."name", $2) > $3 OR ' +
        '(COALESCE("users"."name", $4) = $5 AND "users"."id" > $6)) ' +
        'GROUP BY "users"."id", "users"."name" ' +
        'ORDER BY COALESCE("users"."name", $7) ASC, "users"."id" ASC LIMIT 50',
    );
    expect(calls[0]?.params).toEqual([',', '', 'M', '', 'M', 0, '']);
    // `roles` is typed as string; the unprojected join contributes no row key.
    const r: string = out[0]!.roles;
    expect(r).toBe('admin,ops');
  });

  it('select() pages a cross-table keyset cursor and nests the result', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db, calls } = makeFakeDb(
      [{ id: 2, name: 'B', age: 31, 'o.total': 200 }],
      1,
    );
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    const out = await things.select({
      columns: ['id', 'name'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['total'] },
      },
      keyset: {
        // Key spans the outer table and the joined alias — the cross-table
        // cursor that the offset/subquery path can't express.
        keys: [
          { expr: { col: 'name' }, direction: 'asc' },
          { expr: { alias: 'o', col: 'total' }, direction: 'desc' },
        ],
        after: ['A', 300],
        limit: 25,
      },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT "things"."id", "things"."name", "o"."total" AS "o.total" ' +
        'FROM "things" ' +
        'INNER JOIN "orders" AS "o" ON "things"."id" = "o"."userId" ' +
        'WHERE ("things"."name" > $1 OR ("things"."name" = $2 AND "o"."total" < $3)) ' +
        'ORDER BY "things"."name" ASC, "o"."total" DESC LIMIT 25',
    );
    expect(calls[0]?.params).toEqual(['A', 'A', 300]);
    expect(out).toEqual([{ id: 2, name: 'B', age: 31, o: { total: 200 } }]);
  });

  it('select() rejects keyset refs to unknown aliases (type-level)', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db } = makeFakeDb([], 0);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    await things.select({
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['total'] },
      },
      keyset: {
        // @ts-expect-error 'q' is not a join alias on this call
        keys: [{ expr: { alias: 'q', col: 'total' } }],
        after: [1],
      },
    });
  });

  it('select() rejects orderBy refs to unknown aliases/columns (type-level)', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db } = makeFakeDb([], 0);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    await things.select({
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id', 'total'] },
      },
      orderBy: [
        // @ts-expect-error 'x' is not a join alias on this call
        { alias: 'x', col: 'total' },
        // @ts-expect-error 'nope' is not a column on alias 'o'
        { alias: 'o', col: 'nope' },
      ],
    });
  });

  it('LEFT join with no match sets the joined slot to undefined', async () => {
    type Order = { id: number; userId: number; total: number };
    // Carol has no order — joined cols come back undefined (post null-normalization)
    const { db } = makeFakeDb(
      [
        { id: 1, name: 'A', age: 30, 'o.id': 10, 'o.total': 100 },
        {
          id: 3,
          name: 'Carol',
          age: 32,
          'o.id': undefined,
          'o.total': undefined,
        },
      ],
      2,
    );
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    const out = await things.select({
      columns: ['id', 'name'],
      join: {
        table: orders,
        type: 'left',
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id', 'total'] },
      },
    });

    expect(out[0]?.o).toEqual({ id: 10, total: 100 });
    expect(out[1]?.o).toBeUndefined();
  });

  it('select() throws when a join is missing select.columns', async () => {
    type Order = { id: number; userId: number };
    const { db } = makeFakeDb([], 0);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    await expect(
      things.select({
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
        },
      }),
    ).rejects.toThrow(/Missing or empty columns on alias "o"/);
  });

  it('count with join emits joined COUNT(*) and returns the number', async () => {
    type Order = { id: number; userId: number; status: string };
    const { db, calls } = makeFakeDb([{ count: 5 }], 1);
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    const n = await things.count({
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { where: { status: 'paid' } },
      },
    });

    expect(calls[0]?.sql).toBe(
      'SELECT COUNT(*) AS count FROM "things" ' +
        'INNER JOIN "orders" AS "o" ON "things"."id" = "o"."userId" AND "o"."status" = $1',
    );
    expect(calls[0]?.params).toEqual(['paid']);
    expect(n).toBe(5);
  });

  it('reads the joined table name from DbCore.tableName', () => {
    const { db } = makeFakeDb([], 0);
    const orders = createDbCore<{ id: number }>(db, 'orders');
    expect(orders.tableName).toBe('orders');
  });

  // selectWithCount needs the driver to return different rows for the page
  // query and the count query. Branch on SQL content.
  function makeSplitFakeDb(
    pageRows: unknown[],
    total: number,
  ): { db: Database; calls: Captured[] } {
    const calls: Captured[] = [];
    const driver: Driver = {
      kind: 'pg',
      dialect: pgDialect,
      query<R>(
        sql: string,
        params: readonly unknown[],
      ): Promise<QueryResult<R>> {
        calls.push({ sql, params: [...params] });
        if (sql.startsWith('SELECT COUNT(*)')) {
          return Promise.resolve({
            rows: [{ count: total }] as unknown as R[],
            rowCount: 1,
          });
        }
        return Promise.resolve({
          rows: pageRows as R[],
          rowCount: pageRows.length,
        });
      },
      async close() {},
    };
    return { db: { driver }, calls };
  }

  it('selectWithCount returns { rows, total } and issues both queries', async () => {
    const { db, calls } = makeSplitFakeDb(
      [
        { id: 1, name: 'a', age: 30 },
        { id: 2, name: 'b', age: 31 },
      ],
      42,
    );
    const things = createDbCore<Row>(db, 'things');

    const out = await things.selectWithCount({
      where: { active: true },
      limit: 2,
      offset: 0,
    });

    expect(out.total).toBe(42);
    expect(out.rows).toEqual([
      { id: 1, name: 'a', age: 30 },
      { id: 2, name: 'b', age: 31 },
    ]);
    expect(calls).toHaveLength(2);
  });

  it('selectWithCount drops limit/offset from the count query', async () => {
    const { db, calls } = makeSplitFakeDb([{ id: 1, name: 'a', age: 30 }], 17);
    const things = createDbCore<Row>(db, 'things');

    await things.selectWithCount({
      where: { active: true },
      limit: 10,
      offset: 20,
    });

    const selectCall = calls.find((c) => c.sql.startsWith('SELECT *'));
    const countCall = calls.find((c) => c.sql.startsWith('SELECT COUNT'));

    expect(selectCall?.sql).toContain('LIMIT 10');
    expect(selectCall?.sql).toContain('OFFSET 20');
    expect(countCall?.sql).not.toContain('LIMIT');
    expect(countCall?.sql).not.toContain('OFFSET');
    // The where clause appears in both.
    expect(selectCall?.params).toEqual([true]);
    expect(countCall?.params).toEqual([true]);
  });

  it('selectWithCount + join nests rows and counts join-result rows', async () => {
    type Order = { id: number; userId: number; total: number };
    const { db, calls } = makeSplitFakeDb(
      [{ id: 1, name: 'a', age: 30, 'o.id': 10, 'o.total': 100 }],
      5,
    );
    const things = createDbCore<Row>(db, 'things');
    const orders = createDbCore<Order>(db, 'orders');

    const out = await things.selectWithCount({
      columns: ['id', 'name'],
      join: {
        table: orders,
        type: 'left',
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id', 'total'] },
      },
      limit: 1,
    });

    expect(out.total).toBe(5);
    expect(out.rows).toEqual([
      { id: 1, name: 'a', age: 30, o: { id: 10, total: 100 } },
    ]);
    // Page query: subquery-wrapped because limit is present.
    const pageCall = calls.find((c) => c.sql.includes('AS "page"'));
    expect(pageCall).toBeDefined();
    // Count query: COUNT(*) over the join, no LIMIT.
    const countCall = calls.find((c) => c.sql.startsWith('SELECT COUNT'));
    expect(countCall?.sql).toContain('LEFT JOIN "orders"');
    expect(countCall?.sql).not.toContain('LIMIT');
  });

  it('selectWithCount runs the two queries in parallel', async () => {
    // Verify Promise.all is used — both queries reach the driver before
    // either resolves. Resolve them in reverse arrival order to make sure
    // the result still wires up to the right side.
    const calls: Captured[] = [];
    const resolvers: Array<(v: unknown) => void> = [];
    const driver: Driver = {
      kind: 'pg',
      dialect: pgDialect,
      query<R>(
        sql: string,
        params: readonly unknown[],
      ): Promise<QueryResult<R>> {
        calls.push({ sql, params: [...params] });
        return new Promise<QueryResult<R>>((resolve) => {
          resolvers.push((v) => resolve(v as QueryResult<R>));
        });
      },
      async close() {},
    };
    const things = createDbCore<Row>({ driver }, 'things');

    const promise = things.selectWithCount({ where: { active: true } });

    // Both queries should have been issued before either resolves.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(2);

    // Resolve the count first, then the select — Promise.all should still
    // assemble them in the right slots.
    const countIdx = calls.findIndex((c) => c.sql.startsWith('SELECT COUNT'));
    const selectIdx = 1 - countIdx;
    resolvers[countIdx]!({ rows: [{ count: 99 }], rowCount: 1 });
    resolvers[selectIdx]!({
      rows: [{ id: 1, name: 'a', age: 30 }],
      rowCount: 1,
    });

    const out = await promise;
    expect(out.total).toBe(99);
    expect(out.rows).toEqual([{ id: 1, name: 'a', age: 30 }]);
  });
});
