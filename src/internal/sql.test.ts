import { describe, expect, it } from 'vitest';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from './sql.js';
import { mssqlDialect, mysqlDialect, pgDialect } from './dialect.js';
import type { DbCore } from '../core/dbCore.js';

// Stub DbCore for join targets — buildSelect only reads `tableName`.
const stubDb = <T>(name: string): DbCore<T> =>
  ({ tableName: name }) as DbCore<T>;

type Row = {
  id: number;
  name: string;
  age: number;
  active: boolean;
  bio: string | null;
};

describe('buildSelect', () => {
  it('emits SELECT * with no clauses', () => {
    expect(buildSelect<Row>('users', pgDialect)).toEqual({
      sql: 'SELECT * FROM "users"',
      params: [],
    });
  });

  it('appends WHERE when provided', () => {
    expect(buildSelect<Row>('users', pgDialect, { where: { id: 1 } })).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = $1',
      params: [1],
    });
  });

  it('appends LIMIT/OFFSET on pg', () => {
    expect(
      buildSelect<Row>('users', pgDialect, { limit: 10, offset: 5 }),
    ).toEqual({
      sql: 'SELECT * FROM "users" LIMIT 10 OFFSET 5',
      params: [],
    });
  });

  it('uses MSSQL OFFSET/FETCH with synthetic ORDER BY', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, { limit: 10, offset: 5 }),
    ).toEqual({
      sql: 'SELECT * FROM [users] ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
      params: [],
    });
  });

  it('combines WHERE + LIMIT', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: { active: true },
        limit: 5,
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" WHERE "active" = $1 LIMIT 5',
      params: [true],
    });
  });

  it('appends ORDER BY (single column)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        orderBy: { col: 'age', direction: 'desc' },
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "age" DESC',
      params: [],
    });
  });

  it('appends ORDER BY (multiple columns)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        orderBy: [{ col: 'age', direction: 'desc' }, { col: 'name' }],
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY "age" DESC, "name" ASC',
      params: [],
    });
  });

  it('combines WHERE + ORDER BY + LIMIT (pg)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: { active: true },
        orderBy: { col: 'name' },
        limit: 5,
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" WHERE "active" = $1 ORDER BY "name" ASC LIMIT 5',
      params: [true],
    });
  });

  it('mssql skips synthetic ORDER BY when one is provided', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        orderBy: { col: 'age', direction: 'desc' },
        limit: 10,
        offset: 5,
      }),
    ).toEqual({
      sql: 'SELECT * FROM [users] ORDER BY [age] DESC OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
      params: [],
    });
  });

  it('mssql adds synthetic ORDER BY when paginating without one', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, { limit: 10, offset: 5 }),
    ).toEqual({
      sql: 'SELECT * FROM [users] ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY',
      params: [],
    });
  });

  it('projects a subset of columns when supplied', () => {
    expect(
      buildSelect<Row>('users', pgDialect, { columns: ['id', 'name'] }),
    ).toEqual({
      sql: 'SELECT "id", "name" FROM "users"',
      params: [],
    });
  });

  it('combines projected columns with WHERE / ORDER BY / LIMIT', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id', 'age'],
        where: { active: true },
        orderBy: { col: 'age', direction: 'desc' },
        limit: 5,
      }),
    ).toEqual({
      sql:
        'SELECT "id", "age" FROM "users" WHERE "active" = $1 ' +
        'ORDER BY "age" DESC LIMIT 5',
      params: [true],
    });
  });

  it('quotes projected columns per dialect', () => {
    expect(
      buildSelect<Row>('users', mysqlDialect, { columns: ['id', 'name'] }),
    ).toEqual({
      sql: 'SELECT `id`, `name` FROM `users`',
      params: [],
    });
  });

  it('throws when columns is an empty array', () => {
    expect(() => buildSelect<Row>('users', pgDialect, { columns: [] })).toThrow(
      /'columns' cannot be empty/,
    );
  });

  it('rejects non-integer or negative limit/offset', () => {
    expect(() => buildSelect<Row>('users', pgDialect, { limit: -1 })).toThrow(
      /limit must be a non-negative integer/,
    );
    expect(() => buildSelect<Row>('users', pgDialect, { limit: 1.5 })).toThrow(
      /limit must be a non-negative integer/,
    );
    expect(() => buildSelect<Row>('users', pgDialect, { offset: -1 })).toThrow(
      /offset must be a non-negative integer/,
    );
  });
});

describe('buildCount', () => {
  it('emits SELECT COUNT(*) with no clauses', () => {
    expect(buildCount<Row>('users', pgDialect)).toEqual({
      sql: 'SELECT COUNT(*) AS count FROM "users"',
      params: [],
    });
  });

  it('appends WHERE when provided', () => {
    expect(
      buildCount<Row>('users', pgDialect, { where: { active: true } }),
    ).toEqual({
      sql: 'SELECT COUNT(*) AS count FROM "users" WHERE "active" = $1',
      params: [true],
    });
  });

  it('quotes the table per dialect', () => {
    expect(buildCount<Row>('users', mysqlDialect).sql).toBe(
      'SELECT COUNT(*) AS count FROM `users`',
    );
    expect(buildCount<Row>('users', mssqlDialect).sql).toBe(
      'SELECT COUNT(*) AS count FROM [users]',
    );
  });

  it('emits JOIN clauses without projection aliases', () => {
    type Order = { id: number; userId: number; status: string };
    const orders = stubDb<Order>('orders');
    expect(
      buildCount<Row>('users', pgDialect, {
        where: { active: true },
        join: {
          table: orders,
          type: 'left',
          alias: 'o',
          on: ['id', 'userId'],
          select: { where: { status: 'paid' } },
        },
      }),
    ).toEqual({
      sql:
        'SELECT COUNT(*) AS count FROM "users" ' +
        'LEFT JOIN "orders" AS "o" ON "users"."id" = "o"."userId" AND "o"."status" = $1 ' +
        'WHERE "users"."active" = $2',
      params: ['paid', true],
    });
  });
});

describe('buildSelect with joins', () => {
  type Order = {
    id: number;
    userId: number;
    total: number;
    status: string;
  };
  type Item = { id: number; orderId: number; sku: string };

  const orders = stubDb<Order>('orders');
  const items = stubDb<Item>('items');

  it('emits a single INNER join with alias-prefixed projections', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id', 'name'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id', 'total'] },
        },
      }),
    ).toEqual({
      sql:
        'SELECT "users"."id", "users"."name", "o"."id" AS "o.id", "o"."total" AS "o.total" ' +
        'FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId"',
      params: [],
    });
  });

  it('uses <table>.* when outer columns are omitted', () => {
    const out = buildSelect<Row>('users', pgDialect, {
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'] },
      },
    });
    expect(out.sql.startsWith('SELECT "users".*, "o"."id" AS "o.id" FROM')).toBe(
      true,
    );
  });

  it('emits LEFT JOIN and AND-s join.where into the ON clause', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          type: 'left',
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'], where: { status: 'paid' } },
        },
      }),
    ).toEqual({
      sql:
        'SELECT "users"."id", "o"."id" AS "o.id" FROM "users" ' +
        'LEFT JOIN "orders" AS "o" ON "users"."id" = "o"."userId" AND "o"."status" = $1',
      params: ['paid'],
    });
  });

  it('threads placeholder numbering across join WHERE and outer WHERE', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        where: { active: true },
        join: {
          table: orders,
          type: 'left',
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'], where: { status: 'paid' } },
        },
      }).params,
    ).toEqual(['paid', true]);
  });

  it('emits multi-column ON pairs joined by AND', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: [
            ['id', 'userId'],
            ['id', 'id'],
          ],
          select: { columns: ['id'] },
        },
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id" FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" AND "users"."id" = "o"."id"',
    );
  });

  it('emits nested joins with full alias path in projections, immediate parent in ON', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: {
            columns: ['id'],
            join: {
              table: items,
              alias: 'it',
              on: ['id', 'orderId'],
              select: { columns: ['sku'] },
            },
          },
        },
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id", "it"."sku" AS "o.it.sku" ' +
        'FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'INNER JOIN "items" AS "it" ON "o"."id" = "it"."orderId"',
    );
  });

  it('emits multiple parallel joins (array form)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: [
          {
            table: orders,
            alias: 'o',
            on: ['id', 'userId'],
            select: { columns: ['id'] },
          },
          {
            table: items,
            type: 'left',
            alias: 'i',
            on: ['id', 'orderId'],
            select: { columns: ['sku'] },
          },
        ],
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id", "i"."sku" AS "i.sku" ' +
        'FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'LEFT JOIN "items" AS "i" ON "users"."id" = "i"."orderId"',
    );
  });

  it('supports RIGHT and FULL join keywords', () => {
    const opt = {
      columns: ['id'] as const,
      join: {
        table: orders,
        alias: 'o' as const,
        on: ['id', 'userId'] as const,
        select: { columns: ['id'] as const },
      },
    };
    expect(
      buildSelect<Row>('users', pgDialect, { ...opt, join: { ...opt.join, type: 'right' } }).sql,
    ).toContain('RIGHT JOIN');
    expect(
      buildSelect<Row>('users', pgDialect, { ...opt, join: { ...opt.join, type: 'full' } }).sql,
    ).toContain('FULL JOIN');
  });

  it('quotes identifiers per dialect (mysql backticks)', () => {
    expect(
      buildSelect<Row>('users', mysqlDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
      }).sql,
    ).toBe(
      'SELECT `users`.`id`, `o`.`id` AS `o.id` FROM `users` ' +
        'INNER JOIN `orders` AS `o` ON `users`.`id` = `o`.`userId`',
    );
  });

  it('quotes identifiers per dialect (mssql brackets, @p placeholders)', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        columns: ['id'],
        join: {
          table: orders,
          type: 'left',
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'], where: { status: 'paid' } },
        },
      }),
    ).toEqual({
      sql:
        'SELECT [users].[id], [o].[id] AS [o.id] FROM [users] ' +
        'LEFT JOIN [orders] AS [o] ON [users].[id] = [o].[userId] AND [o].[status] = @p1',
      params: ['paid'],
    });
  });

  it('throws when a join supplies an empty on array', () => {
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: [] as unknown as readonly [string, string],
          select: { columns: ['id'] },
        },
      }),
    ).toThrow(/join 'on' cannot be empty/);
  });

  it('throws when a join supplies an empty columns array', () => {
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: [] },
        },
      }),
    ).toThrow(/join 'select\.columns' cannot be empty/);
  });

  it('throws on an invalid join type', () => {
    // Cast bypasses the literal-union check so we can exercise the runtime
    // guard. Consumers writing TypeScript can't actually pass an invalid
    // type because the JoinType union narrows it at the call site.
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          type: 'cross' as 'inner',
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
      }),
    ).toThrow(/invalid join type "cross"/);
  });
});

describe('buildInsert', () => {
  it('emits INSERT with the supplied columns', () => {
    expect(
      buildInsert<Row>('users', pgDialect, {
        id: 1,
        name: 'a',
        age: 30,
        active: true,
        bio: null,
      }),
    ).toEqual({
      sql: 'INSERT INTO "users" ("id", "name", "age", "active", "bio") VALUES ($1, $2, $3, $4, $5)',
      params: [1, 'a', 30, true, null],
    });
  });

  it('skips undefined values (treats them as omitted)', () => {
    expect(
      buildInsert<Row>('users', pgDialect, {
        id: 1,
        name: 'a',
        age: undefined,
        active: true,
        bio: null,
      }),
    ).toEqual({
      sql: 'INSERT INTO "users" ("id", "name", "active", "bio") VALUES ($1, $2, $3, $4)',
      params: [1, 'a', true, null],
    });
  });

  it('throws when no columns survive after filtering', () => {
    expect(() => buildInsert<Row>('users', pgDialect, {})).toThrow(
      /at least one column value/,
    );
  });

  it('appends RETURNING * on pg when returnRows is true', () => {
    expect(
      buildInsert<Row>(
        'users',
        pgDialect,
        { id: 1, name: 'a', age: 30, active: true, bio: null },
        true,
      ).sql,
    ).toBe(
      'INSERT INTO "users" ("id", "name", "age", "active", "bio") VALUES ($1, $2, $3, $4, $5) RETURNING *',
    );
  });

  it('injects OUTPUT INSERTED.* mid-statement on mssql when returnRows is true', () => {
    expect(
      buildInsert<Row>(
        'users',
        mssqlDialect,
        { id: 1, name: 'a', age: 30, active: true, bio: null },
        true,
      ).sql,
    ).toBe(
      'INSERT INTO [users] ([id], [name], [age], [active], [bio]) OUTPUT INSERTED.* VALUES (@p1, @p2, @p3, @p4, @p5)',
    );
  });

  it('does not add returning syntax on mysql even when requested', () => {
    expect(
      buildInsert<Row>(
        'users',
        mysqlDialect,
        { id: 1, name: 'a', age: 30, active: true, bio: null },
        true,
      ).sql,
    ).toBe(
      'INSERT INTO `users` (`id`, `name`, `age`, `active`, `bio`) VALUES (?, ?, ?, ?, ?)',
    );
  });
});

describe('buildUpdate', () => {
  it('emits UPDATE with SET and WHERE; placeholder numbering is contiguous', () => {
    expect(
      buildUpdate<Row>('users', pgDialect, {
        set: { name: 'b', age: 31 },
        where: { id: 1 },
      }),
    ).toEqual({
      sql: 'UPDATE "users" SET "name" = $1, "age" = $2 WHERE "id" = $3',
      params: ['b', 31, 1],
    });
  });

  it('renders null in SET as literal NULL', () => {
    expect(
      buildUpdate<Row>('users', pgDialect, {
        set: { bio: null },
        where: { id: 1 },
      }),
    ).toEqual({
      sql: 'UPDATE "users" SET "bio" = NULL WHERE "id" = $1',
      params: [1],
    });
  });

  it('throws when SET is empty', () => {
    expect(() =>
      buildUpdate<Row>('users', pgDialect, {
        set: {},
        where: { id: 1 },
      }),
    ).toThrow(/at least one column in 'set'/);
  });

  it('throws when WHERE is empty (refuses to update all rows)', () => {
    expect(() =>
      buildUpdate<Row>('users', pgDialect, {
        set: { name: 'b' },
        where: {},
      }),
    ).toThrow(/refusing to update all rows/);
  });

  it('appends RETURNING * on pg when returnRows is true', () => {
    expect(
      buildUpdate<Row>(
        'users',
        pgDialect,
        { set: { name: 'b' }, where: { id: 1 } },
        true,
      ).sql,
    ).toBe('UPDATE "users" SET "name" = $1 WHERE "id" = $2 RETURNING *');
  });

  it('injects OUTPUT INSERTED.* between SET and WHERE on mssql', () => {
    expect(
      buildUpdate<Row>(
        'users',
        mssqlDialect,
        { set: { name: 'b' }, where: { id: 1 } },
        true,
      ).sql,
    ).toBe(
      'UPDATE [users] SET [name] = @p1 OUTPUT INSERTED.* WHERE [id] = @p2',
    );
  });

  it('emits no returning syntax on mysql even when requested', () => {
    expect(
      buildUpdate<Row>(
        'users',
        mysqlDialect,
        { set: { name: 'b' }, where: { id: 1 } },
        true,
      ).sql,
    ).toBe('UPDATE `users` SET `name` = ? WHERE `id` = ?');
  });
});

describe('buildDelete', () => {
  it('emits DELETE with WHERE', () => {
    expect(buildDelete<Row>('users', pgDialect, { where: { id: 1 } })).toEqual({
      sql: 'DELETE FROM "users" WHERE "id" = $1',
      params: [1],
    });
  });

  it('throws when WHERE is empty (refuses to delete all rows)', () => {
    expect(() => buildDelete<Row>('users', pgDialect, { where: {} })).toThrow(
      /refusing to delete all rows/,
    );
  });
});
