import type { Database } from './database.js';

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

export type SelectOptions<T> = {
  where?: Where<T>;
  limit?: number;
  offset?: number;
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
  const notImplemented = (op: string): Promise<never> =>
    Promise.reject(
      new Error(
        `altacore: createDbCore.${op} is not yet implemented (table=${table}, driver=${db.driver.kind})`,
      ),
    );

  return {
    select: () => notImplemented('select'),
    insert: () => notImplemented('insert'),
    update: () => notImplemented('update'),
    delete: () => notImplemented('delete'),
  };
}
