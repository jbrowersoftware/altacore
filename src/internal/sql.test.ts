import { describe, expect, it } from 'vitest';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from './sql.js';
import { mssqlDialect, mysqlDialect, pgDialect } from './dialect.js';

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
