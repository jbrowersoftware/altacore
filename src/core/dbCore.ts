import type { Database } from './database.js';
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from '../internal/sql.js';

export type WhereOperators<V> = {
  eq?: V;
  ne?: V;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  in?: readonly V[];
  nin?: readonly V[];
  like?: V extends string ? string : never;
};

export type WhereCondition<V> = V | WhereOperators<V>;

export type Where<T> = {
  [K in keyof T]?: WhereCondition<T[K]>;
};

export type OrderBy<T> = {
  col: keyof T & string;
  direction?: 'asc' | 'desc';
};

export type SelectOptions<T> = {
  where?: Where<T>;
  limit?: number;
  offset?: number;
  orderBy?: OrderBy<T> | OrderBy<T>[];
};

export type UpdateOptions<T> = {
  where: Where<T>;
  set: Partial<T>;
};

export type DeleteOptions<T> = {
  where: Where<T>;
};

export type DbCore<T> = {
  select: (options?: SelectOptions<T>) => Promise<T[]>;
  insert: (values: T) => Promise<T>;
  update: (options: UpdateOptions<T>) => Promise<T[]>;
  delete: (options: DeleteOptions<T>) => Promise<number>;
};

export function createDbCore<T>(db: Database, table: string): DbCore<T> {
  const driver = db.driver;
  const dialect = driver.dialect;

  const supportsReturn = dialect.returningStrategy !== 'none';

  return {
    async select(options) {
      const { sql, params } = buildSelect<T>(table, dialect, options);
      const result = await driver.query<T>(sql, params);
      return result.rows;
    },
    async insert(values) {
      const { sql, params } = buildInsert<T>(
        table,
        dialect,
        values,
        supportsReturn,
      );
      const result = await driver.query<T>(sql, params);
      const first = result.rows[0];
      // pg/mssql: first row is the DB's view of the inserted record (defaults,
      // triggers, autogen all reflected). mysql: no native return — echo input.
      if (supportsReturn && first !== undefined) return first;
      return values;
    },
    async update(options) {
      const { sql, params } = buildUpdate<T>(
        table,
        dialect,
        options,
        supportsReturn,
      );
      const result = await driver.query<T>(sql, params);
      // pg/mssql: rows are the post-update state. mysql: no return — empty.
      return supportsReturn ? result.rows : [];
    },
    async delete(options) {
      const { sql, params } = buildDelete<T>(table, dialect, options);
      const result = await driver.query(sql, params);
      return result.rowCount;
    },
  };
}
