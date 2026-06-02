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

  it('paginated join wraps the outer table in a subquery (LIMIT only)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id', 'name'],
        where: { active: true },
        join: {
          table: orders,
          type: 'left',
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id', 'total'], where: { status: 'paid' } },
        },
        limit: 10,
      }),
    ).toEqual({
      sql:
        'SELECT "page"."id", "page"."name", "o"."id" AS "o.id", "o"."total" AS "o.total" ' +
        'FROM (SELECT * FROM "users" WHERE "active" = $1 LIMIT 10) AS "page" ' +
        'LEFT JOIN "orders" AS "o" ON "page"."id" = "o"."userId" AND "o"."status" = $2',
      params: [true, 'paid'],
    });
  });

  it('paginated join honors OFFSET as well as LIMIT', () => {
    const out = buildSelect<Row>('users', pgDialect, {
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'] },
      },
      limit: 10,
      offset: 20,
    });
    expect(out.sql).toContain('(SELECT * FROM "users" LIMIT 10 OFFSET 20) AS "page"');
    expect(out.sql).toContain('"page"."id" = "o"."userId"');
  });

  it('paginated join applies ORDER BY both inside (pagination) and outside (result ordering)', () => {
    const out = buildSelect<Row>('users', pgDialect, {
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'] },
      },
      orderBy: { col: 'id', direction: 'desc' },
      limit: 5,
    });
    // Inner ORDER BY drives the pagination.
    expect(out.sql).toContain('ORDER BY "id" DESC LIMIT 5');
    // Outer ORDER BY keeps the post-join result rows in the same outer order.
    expect(out.sql.endsWith('ORDER BY "page"."id" DESC')).toBe(true);
  });

  it('paginated join with no outer columns falls back to page.*', () => {
    const out = buildSelect<Row>('users', pgDialect, {
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'] },
      },
      limit: 5,
    });
    expect(out.sql.startsWith('SELECT "page".*, "o"."id" AS "o.id" FROM')).toBe(
      true,
    );
  });

  it('paginated join on mssql injects the synthetic ORDER BY inside the subquery', () => {
    // OFFSET/FETCH requires ORDER BY; the inner subquery is what paginates,
    // so the synthetic order goes there — not on the outer SELECT.
    const out = buildSelect<Row>('users', mssqlDialect, {
      columns: ['id'],
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'] },
      },
      limit: 10,
      offset: 5,
    });
    expect(out.sql).toContain(
      '(SELECT * FROM [users] ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY) AS [page]',
    );
  });

  it('paginated join threads placeholders: outer WHERE first, then join WHERE', () => {
    const out = buildSelect<Row>('users', pgDialect, {
      columns: ['id'],
      where: { active: true },
      join: {
        table: orders,
        alias: 'o',
        on: ['id', 'userId'],
        select: { columns: ['id'], where: { status: 'paid' } },
      },
      limit: 10,
    });
    // Order: outer.where ($1) inside the subquery, then join.where ($2) in ON.
    expect(out.params).toEqual([true, 'paid']);
    expect(out.sql).toContain('WHERE "active" = $1 LIMIT 10');
    expect(out.sql).toContain('AND "o"."status" = $2');
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

describe('buildSelect — qualified orderBy & COALESCE', () => {
  type Order = { id: number; userId: number; total: number; status: string };
  const orders = stubDb<Order>('orders');

  it('orders by a joined alias column (qualified)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
        orderBy: [
          { alias: 'o', col: 'total', direction: 'desc' },
          { col: 'name' },
        ],
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id" FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'ORDER BY "o"."total" DESC, "users"."name" ASC',
    );
  });

  it('orders by COALESCE(col, fallback) — single table', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        orderBy: { coalesce: [{ col: 'bio' }, ''], direction: 'asc' },
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" ORDER BY COALESCE("bio", $1) ASC',
      params: [''],
    });
  });

  it('numbers COALESCE order params after the WHERE params', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: { active: true },
        orderBy: { coalesce: [{ col: 'bio' }, 'z'] },
      }),
    ).toEqual({
      sql: 'SELECT * FROM "users" WHERE "active" = $1 ORDER BY COALESCE("bio", $2) ASC',
      params: [true, 'z'],
    });
  });

  it('keeps COALESCE order params before LIMIT/FETCH on mssql', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        orderBy: { coalesce: [{ col: 'bio' }, 'z'] },
        limit: 5,
      }),
    ).toEqual({
      sql: 'SELECT * FROM [users] ORDER BY COALESCE([bio], @p1) ASC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
      params: ['z'],
    });
  });
});

describe('buildSelect — groupBy', () => {
  type Order = { id: number; userId: number; total: number; status: string };
  const orders = stubDb<Order>('orders');

  it('emits GROUP BY for a single column (single table)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
      }).sql,
    ).toBe('SELECT "active" FROM "users" GROUP BY "active"');
  });

  it('orders WHERE / GROUP BY / ORDER BY and threads params', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        where: { age: { gt: 18 } },
        groupBy: { col: 'active' },
        orderBy: { col: 'active' },
      }),
    ).toEqual({
      sql: 'SELECT "active" FROM "users" WHERE "age" > $1 GROUP BY "active" ORDER BY "active" ASC',
      params: [18],
    });
  });

  it('groups by outer and joined alias columns', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
        groupBy: [{ col: 'id' }, { alias: 'o', col: 'status' }],
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id" FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'GROUP BY "users"."id", "o"."status"',
    );
  });

  it('quotes GROUP BY per dialect (mysql)', () => {
    expect(
      buildSelect<Row>('users', mysqlDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
      }).sql,
    ).toBe('SELECT `active` FROM `users` GROUP BY `active`');
  });
});

describe('buildSelect — aggregates', () => {
  type Order = { id: number; userId: number; total: number; status: string };
  const orders = stubDb<Order>('orders');

  it('emits COUNT(*) alongside a grouped column', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [{ fn: 'count', arg: '*', as: 'n' }],
      }).sql,
    ).toBe('SELECT "active", COUNT(*) AS "n" FROM "users" GROUP BY "active"');
  });

  it('emits COUNT(DISTINCT col)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [{ fn: 'count', arg: { col: 'id' }, distinct: true, as: 'ids' }],
      }).sql,
    ).toBe(
      'SELECT "active", COUNT(DISTINCT "id") AS "ids" FROM "users" GROUP BY "active"',
    );
  });

  it('emits SUM and threads WHERE params after (param-less) aggregate', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        where: { age: { gt: 18 } },
        groupBy: { col: 'active' },
        aggregates: [{ fn: 'sum', arg: { col: 'age' }, as: 'totalAge' }],
      }),
    ).toEqual({
      sql:
        'SELECT "active", SUM("age") AS "totalAge" FROM "users" ' +
        'WHERE "age" > $1 GROUP BY "active"',
      params: [18],
    });
  });

  it('counts a DISTINCT joined-alias column with GROUP BY on the outer table', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
        groupBy: { col: 'id' },
        aggregates: [
          { fn: 'count', arg: { alias: 'o', col: 'id' }, distinct: true, as: 'orderCount' },
        ],
      }).sql,
    ).toBe(
      'SELECT "users"."id", "o"."id" AS "o.id", ' +
        'COUNT(DISTINCT "o"."id") AS "orderCount" FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'GROUP BY "users"."id"',
    );
  });

  it('numbers a COALESCE aggregate arg before the WHERE params', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        where: { active: true },
        groupBy: { col: 'active' },
        aggregates: [{ fn: 'sum', arg: { coalesce: [{ col: 'age' }, 0] }, as: 's' }],
      }),
    ).toEqual({
      sql:
        'SELECT "active", SUM(COALESCE("age", $1)) AS "s" FROM "users" ' +
        'WHERE "active" = $2 GROUP BY "active"',
      params: [0, true],
    });
  });

  it('quotes aggregate output + DISTINCT col per dialect (mssql)', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [{ fn: 'count', arg: { col: 'id' }, distinct: true, as: 'ids' }],
      }).sql,
    ).toBe(
      'SELECT [active], COUNT(DISTINCT [id]) AS [ids] FROM [users] GROUP BY [active]',
    );
  });

  it('emits STRING_AGG with a bound separator (pg)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [
          { fn: 'stringAgg', arg: { col: 'name' }, separator: ', ', as: 'names' },
        ],
      }),
    ).toEqual({
      sql:
        'SELECT "active", STRING_AGG("name", $1) AS "names" FROM "users" ' +
        'GROUP BY "active"',
      params: [', '],
    });
  });

  it('emits GROUP_CONCAT(... SEPARATOR ?) on mysql', () => {
    expect(
      buildSelect<Row>('users', mysqlDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [
          { fn: 'stringAgg', arg: { col: 'name' }, separator: ', ', as: 'names' },
        ],
      }),
    ).toEqual({
      sql:
        'SELECT `active`, GROUP_CONCAT(`name` SEPARATOR ?) AS `names` ' +
        'FROM `users` GROUP BY `active`',
      params: [', '],
    });
  });

  it('emits STRING_AGG on mssql with @p separator', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        columns: ['active'],
        groupBy: { col: 'active' },
        aggregates: [
          { fn: 'stringAgg', arg: { col: 'name' }, separator: '; ', as: 'names' },
        ],
      }),
    ).toEqual({
      sql:
        'SELECT [active], STRING_AGG([name], @p1) AS [names] FROM [users] ' +
        'GROUP BY [active]',
      params: ['; '],
    });
  });
});

describe('buildSelect — EXISTS / NOT EXISTS', () => {
  type Order = { id: number; userId: number; total: number; status: string };
  type Item = { id: number; orderId: number; sku: string };
  const orders = stubDb<Order>('orders');
  const items = stubDb<Item>('items');

  it('emits a correlated EXISTS with the outer column qualified', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: { exists: { table: orders, on: ['id', 'userId'] } },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" WHERE EXISTS (SELECT 1 FROM "orders" AS "_ex0" ' +
        'WHERE "_ex0"."userId" = "users"."id")',
      params: [],
    });
  });

  it('emits NOT EXISTS with an extra alias-scoped sub-filter', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: {
          notExists: {
            table: orders,
            on: ['id', 'userId'],
            where: { status: 'paid' },
          },
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" WHERE NOT EXISTS (SELECT 1 FROM "orders" AS "_ex0" ' +
        'WHERE "_ex0"."userId" = "users"."id" AND "_ex0"."status" = $1)',
      params: ['paid'],
    });
  });

  it('threads params across a column condition and the EXISTS sub-filter', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: {
          active: true,
          exists: {
            table: orders,
            on: ['id', 'userId'],
            where: { total: { gt: 100 } },
          },
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" WHERE "active" = $1 AND EXISTS ' +
        '(SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "users"."id" ' +
        'AND "_ex0"."total" > $2)',
      params: [true, 100],
    });
  });

  it('gives each EXISTS in an array a unique alias', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: {
          exists: [
            { table: orders, on: ['id', 'userId'] },
            { table: items, on: ['id', 'orderId'] },
          ],
        },
      }).sql,
    ).toBe(
      'SELECT * FROM "users" WHERE ' +
        'EXISTS (SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "users"."id") ' +
        'AND EXISTS (SELECT 1 FROM "items" AS "_ex1" WHERE "_ex1"."orderId" = "users"."id")',
    );
  });

  it('supports multi-column correlation', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: {
          exists: {
            table: orders,
            on: [
              ['id', 'userId'],
              ['age', 'total'],
            ],
          },
        },
      }).sql,
    ).toBe(
      'SELECT * FROM "users" WHERE EXISTS (SELECT 1 FROM "orders" AS "_ex0" ' +
        'WHERE "_ex0"."userId" = "users"."id" AND "_ex0"."total" = "users"."age")',
    );
  });

  it('works inside an OR group', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: {
          or: [{ active: true }, { exists: { table: orders, on: ['id', 'userId'] } }],
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" WHERE ("active" = $1 OR EXISTS ' +
        '(SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "users"."id"))',
      params: [true],
    });
  });

  it('quotes the EXISTS subquery per dialect (mssql)', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        where: {
          exists: {
            table: orders,
            on: ['id', 'userId'],
            where: { status: 'paid' },
          },
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM [users] WHERE EXISTS (SELECT 1 FROM [orders] AS [_ex0] ' +
        'WHERE [_ex0].[userId] = [users].[id] AND [_ex0].[status] = @p1)',
      params: ['paid'],
    });
  });

  it('correlates EXISTS inside a count() WHERE', () => {
    expect(
      buildCount<Row>('users', pgDialect, {
        where: { exists: { table: orders, on: ['id', 'userId'] } },
      }),
    ).toEqual({
      sql:
        'SELECT COUNT(*) AS count FROM "users" WHERE EXISTS ' +
        '(SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "users"."id")',
      params: [],
    });
  });
});

describe('buildSelect — keyset cursor', () => {
  type Order = { id: number; userId: number; total: number; status: string };
  const orders = stubDb<Order>('orders');

  it('emits an expanded lexicographic seek for a 2-key cursor (single table)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        keyset: {
          keys: [
            { expr: { col: 'age' }, direction: 'asc' },
            { expr: { col: 'id' }, direction: 'asc' },
          ],
          after: [30, 100],
          limit: 20,
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" ' +
        'WHERE ("age" > $1 OR ("age" = $2 AND "id" > $3)) ' +
        'ORDER BY "age" ASC, "id" ASC LIMIT 20',
      params: [30, 30, 100],
    });
  });

  it('spans outer + joined alias columns with mixed directions', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        columns: ['id'],
        join: {
          table: orders,
          alias: 'o',
          on: ['id', 'userId'],
          select: { columns: ['id'] },
        },
        keyset: {
          keys: [
            { expr: { col: 'name' }, direction: 'asc' },
            { expr: { alias: 'o', col: 'total' }, direction: 'desc' },
          ],
          after: ['Acme', 500],
          limit: 50,
        },
      }),
    ).toEqual({
      sql:
        'SELECT "users"."id", "o"."id" AS "o.id" FROM "users" ' +
        'INNER JOIN "orders" AS "o" ON "users"."id" = "o"."userId" ' +
        'WHERE ("users"."name" > $1 OR ("users"."name" = $2 AND "o"."total" < $3)) ' +
        'ORDER BY "users"."name" ASC, "o"."total" DESC LIMIT 50',
      params: ['Acme', 'Acme', 500],
    });
  });

  it('supports a COALESCE key for nullable-column cursors', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        keyset: {
          keys: [
            { expr: { coalesce: [{ col: 'bio' }, '' ] }, direction: 'asc' },
            { expr: { col: 'id' }, direction: 'asc' },
          ],
          after: ['x', 5],
          limit: 10,
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" ' +
        'WHERE (COALESCE("bio", $1) > $2 OR ' +
        '(COALESCE("bio", $3) = $4 AND "id" > $5)) ' +
        'ORDER BY COALESCE("bio", $6) ASC, "id" ASC LIMIT 10',
      params: ['', 'x', '', 'x', 5, ''],
    });
  });

  it('AND-s a regular WHERE with the seek predicate (single key unwrapped)', () => {
    expect(
      buildSelect<Row>('users', pgDialect, {
        where: { active: true },
        keyset: { keys: [{ expr: { col: 'id' } }], after: [5], limit: 10 },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM "users" WHERE "active" = $1 AND "id" > $2 ' +
        'ORDER BY "id" ASC LIMIT 10',
      params: [true, 5],
    });
  });

  it('uses MSSQL OFFSET/FETCH (keyset always has ORDER BY)', () => {
    expect(
      buildSelect<Row>('users', mssqlDialect, {
        keyset: {
          keys: [{ expr: { col: 'age' } }, { expr: { col: 'id' } }],
          after: [30, 100],
          limit: 20,
        },
      }),
    ).toEqual({
      sql:
        'SELECT * FROM [users] ' +
        'WHERE ([age] > @p1 OR ([age] = @p2 AND [id] > @p3)) ' +
        'ORDER BY [age] ASC, [id] ASC OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY',
      params: [30, 30, 100],
    });
  });

  it('rejects keyset combined with limit/offset', () => {
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        limit: 5,
        keyset: { keys: [{ expr: { col: 'id' } }], after: [1] },
      }),
    ).toThrow(/'keyset' cannot be combined with 'limit'\/'offset'/);
  });

  it('rejects an after-list whose length differs from keys', () => {
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        keyset: {
          keys: [{ expr: { col: 'age' } }, { expr: { col: 'id' } }],
          after: [30],
        },
      }),
    ).toThrow(/one value per key/);
  });

  it('rejects an empty keys array', () => {
    expect(() =>
      buildSelect<Row>('users', pgDialect, {
        keyset: { keys: [], after: [] },
      }),
    ).toThrow(/keyset 'keys' cannot be empty/);
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
