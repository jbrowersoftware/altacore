import type { Database } from './database.js';
import {
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
} from '../internal/sql.js';

export type WhereOperators<V> = {
  // null is always permitted on eq/ne — translated to IS NULL / IS NOT NULL.
  // Legal SQL on any column regardless of nullability; on a NOT NULL column it
  // simply yields always-false / always-true.
  eq?: V | null;
  ne?: V | null;
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  in?: readonly V[];
  nin?: readonly V[];
  like?: V extends string ? string : never;
};

// Bare null is also accepted (translated to IS NULL) for the same reason.
export type WhereCondition<V> = V | null | WhereOperators<V>;

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
  // Project a subset of columns. Omit to SELECT *.
  columns?: readonly (keyof T & string)[];
};

export type UpdateOptions<T> = {
  where: Where<T>;
  set: Partial<T>;
};

export type DeleteOptions<T> = {
  where: Where<T>;
};

// Two-overload signature: when `columns` is supplied as a literal array,
// the return type narrows to Pick<T, K>[]; otherwise, T[].
export type SelectFn<T> = {
  <K extends keyof T & string>(
    options: SelectOptions<T> & { columns: readonly K[] },
  ): Promise<Pick<T, K>[]>;
  (options?: SelectOptions<T>): Promise<T[]>;
};

export type DbCore<T> = {
  select: SelectFn<T>;
  insert: (values: Partial<T>) => Promise<T>;
  update: (options: UpdateOptions<T>) => Promise<T[]>;
  delete: (options: DeleteOptions<T>) => Promise<number>;
};

export function createDbCore<T>(db: Database, table: string): DbCore<T> {
  const driver = db.driver;
  const dialect = driver.dialect;

  const supportsReturn = dialect.returningStrategy !== 'none';

  // The implementation has a single signature; the overloads on SelectFn
  // narrow the return type at the call site based on whether columns is given.
  const select = (async (options?: SelectOptions<T>) => {
    const { sql, params } = buildSelect<T>(table, dialect, options);
    const result = await driver.query<T>(sql, params);
    return result.rows;
  }) as SelectFn<T>;

  return {
    select,
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
      // triggers, autogen all reflected). mysql: no native return — echo the
      // input. Fields the user didn't supply will simply be absent on the
      // returned object; consumers needing a full row on mysql should select.
      if (supportsReturn && first !== undefined) return first;
      return values as T;
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
