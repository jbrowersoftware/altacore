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

type Row = { id: number; name: string; age: number };

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
});
