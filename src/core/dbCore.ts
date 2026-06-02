import type { Database } from './database.js';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelect,
  buildUpdate,
  type SelectInput,
} from '../internal/sql.js';
import { assertJoinColumns, nestJoinedRow } from '../internal/nest.js';

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

// 'and' and 'or' are reserved group keys at the top level of a Where<T>;
// columns named `and`/`or` cannot be filtered via the property syntax and must
// be addressed inside a group instead.
type ColumnWhere<T> = {
  [K in keyof T as K extends 'and' | 'or' ? never : K]?: WhereCondition<T[K]>;
};

export type Where<T> = ColumnWhere<T> & {
  and?: readonly Where<T>[];
  or?: readonly Where<T>[];
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

// -----------------------------------------------------------------------------
// Join types
// -----------------------------------------------------------------------------
// `select` and `count` both accept `join`. The result row is nested: every
// join contributes `{ [alias]: <projected joined row> }` onto the outer row.
// LEFT/FULL joins with no match leave the joined slot as `undefined`.
//
// `where` inside `join.select` is AND-ed into the ON clause, NOT the outer
// WHERE — this preserves LEFT/FULL semantics. See docs/joins-where-semantics.md.
//
// Runtime constraint: when `select()` is called with joins, every join must
// supply `select.columns` so the SQL builder can emit alias-qualified
// projections (`"<alias>"."<col>" AS "<alias>.<col>"`) and the result mapper
// can nest rows by dotted key. `count()` ignores both `select` and `columns`
// since no projection is happening.

export type JoinType = 'inner' | 'left' | 'right' | 'full';

// One ON predicate. Multiple pairs AND together inside the ON clause.
//   on: ['otherId', 'id']                                       // single
//   on: [['tenantId', 'tenantId'], ['userId', 'id']]            // multi-column
export type OnPair<L, R> = readonly [keyof L & string, keyof R & string];
export type OnSpec<L, R> = OnPair<L, R> | readonly OnPair<L, R>[];

export type JoinSelect<R> = {
  columns?: readonly (keyof R & string)[];
  where?: Where<R>;
  join?: AnyJoin<R> | readonly AnyJoin<R>[];
};

export type JoinSpec<L, R, A extends string> = {
  table: DbCore<R>;
  type?: JoinType; // default 'inner'
  alias: A;
  on: OnSpec<L, R>;
  select?: JoinSelect<R>;
};

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
// Two lint exceptions in this block:
// - `any`: DbCore<T> is invariant in T (Partial<T> in insert is contravariant),
//   so `unknown` doesn't act as a supertype. The joined-row R and alias A are
//   re-inferred at the pattern-match sites downstream
//   (`J extends JoinSpec<any, infer R, any>`); this `any` only exists to
//   satisfy the recursive `join?` field in JoinSelect.
// - `{}`: used as the identity element for the intersection that composes
//   the joined-row type. Replacing with `object` or `unknown` would break
//   `X & {} ≡ X` and corrupt the alias-entry merging.
export type AnyJoin<L> = JoinSpec<L, any, string>;

// ---- Internal computed-row machinery (not exported) ----

type UnionToIntersection<U> = (U extends any ? (x: U) => void : never) extends (
  x: infer I,
) => void
  ? I
  : never;

type Optional<X, T extends JoinType | undefined> = T extends 'left' | 'full'
  ? X | undefined
  : X;

// `[K] extends [keyof R]` (non-distributive) is load-bearing — the bare
// `K extends keyof R` distributes over the column union, yielding
// `Pick<R, 'a'> | Pick<R, 'b'>` instead of `Pick<R, 'a' | 'b'>`.
type ProjectColumns<R, C> = C extends readonly (infer K)[]
  ? [K] extends [keyof R]
    ? Pick<R, K>
    : never
  : R;

type JoinedRow<J> = J extends JoinSpec<any, infer R, any>
  ? ProjectColumns<
      R,
      J extends { select: { columns: infer C } } ? C : undefined
    > &
      NestedFromSelect<J extends { select: infer S } ? S : undefined>
  : never;

type NestedFromSelect<S> = S extends { join: infer J }
  ? J extends readonly any[]
    ? UnionToIntersection<JoinAliasEntry<J[number]>>
    : JoinAliasEntry<J>
  : {};

type JoinAliasEntry<J> = J extends JoinSpec<any, any, infer A>
  ? {
      [K in A]: Optional<
        JoinedRow<J>,
        J extends { type: infer T } ? T & JoinType : 'inner'
      >;
    }
  : {};

type AllJoinEntries<J extends readonly AnyJoin<any>[]> = UnionToIntersection<
  { [I in keyof J]: JoinAliasEntry<J[I]> }[number]
>;
/* eslint-enable @typescript-eslint/no-explicit-any */

type OuterRow<T, K> = [K] extends [never]
  ? T
  : Pick<T, K extends keyof T ? K : never>;

export type CountOptions<T> = {
  where?: Where<T>;
  join?: AnyJoin<T> | readonly AnyJoin<T>[];
};

export type UpdateOptions<T> = {
  where: Where<T>;
  set: Partial<T>;
};

export type DeleteOptions<T> = {
  where: Where<T>;
};

// Overload ordering is significant — TS picks the first matching signature.
// Join-bearing overloads come first so they win when `join` is present;
// when absent, control falls through to the column-projection and bare-T[]
// overloads.
//
// `const J` (TS 5.0+) is load-bearing for the join overloads — without it,
// `alias: 'o'` widens to `string` (producing index-signature rows) and
// `select.columns: ['id', ...]` widens to `string[]` (collapsing the
// projected Pick to `never`).
export type SelectFn<T> = {
  // Single join object.
  <K extends keyof T & string, const J extends AnyJoin<T>>(
    options: SelectOptions<T> & { columns?: readonly K[]; join: J },
  ): Promise<Array<OuterRow<T, K> & JoinAliasEntry<J>>>;

  // Array of joins.
  <K extends keyof T & string, const J extends readonly AnyJoin<T>[]>(
    options: SelectOptions<T> & { columns?: readonly K[]; join: J },
  ): Promise<Array<OuterRow<T, K> & AllJoinEntries<J>>>;

  // No-join, with column projection — narrows return to Pick<T, K>[].
  <K extends keyof T & string>(
    options: SelectOptions<T> & { columns: readonly K[] },
  ): Promise<Pick<T, K>[]>;

  // No-join, no projection.
  (options?: SelectOptions<T>): Promise<T[]>;
};

export type DbCore<T> = {
  // The SQL table name passed to createDbCore. Exposed because joins need
  // to reach through `JoinSpec.table` (a DbCore reference) to emit the
  // joined-table identifier; also useful for introspection.
  readonly tableName: string;
  select: SelectFn<T>;
  count: (options?: CountOptions<T>) => Promise<number>;
  insert: (values: Partial<T>) => Promise<T>;
  update: (options: UpdateOptions<T>) => Promise<T[]>;
  delete: (options: DeleteOptions<T>) => Promise<number>;
};

export function createDbCore<T>(db: Database, table: string): DbCore<T> {
  const driver = db.driver;
  const dialect = driver.dialect;

  const supportsReturn = dialect.returningStrategy !== 'none';

  // The implementation has a single signature; the overloads on SelectFn
  // narrow the return type at the call site based on whether columns/join
  // are given. The internal `SelectInput<T>` widens the options to include
  // `join?` so the runtime can read it; the cast to `SelectFn<T>` restores
  // the multi-overload public type.
  const select = (async (options?: SelectInput<T>) => {
    const joins = options?.join;
    if (joins) assertJoinColumns(joins);
    const { sql, params } = buildSelect<T>(table, dialect, options);
    const result = await driver.query<Record<string, unknown>>(sql, params);
    if (!joins) return result.rows as unknown as T[];
    return result.rows.map((r) => nestJoinedRow(r, joins));
  }) as SelectFn<T>;

  const count = async (options?: CountOptions<T>): Promise<number> => {
    const { sql, params } = buildCount<T>(table, dialect, options);
    const result = await driver.query<{ count: number | string }>(sql, params);
    // pg returns COUNT(*) as a bigint string; coerce so consumers get a number.
    return Number(result.rows[0]?.count ?? 0);
  };

  const insert = async (values: Partial<T>): Promise<T> => {
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
  };

  const update = async (options: UpdateOptions<T>): Promise<T[]> => {
    const { sql, params } = buildUpdate<T>(
      table,
      dialect,
      options,
      supportsReturn,
    );
    const result = await driver.query<T>(sql, params);
    // pg/mssql: rows are the post-update state. mysql: no return — empty.
    return supportsReturn ? result.rows : [];
  };

  const del = async (options: DeleteOptions<T>): Promise<number> => {
    const { sql, params } = buildDelete<T>(table, dialect, options);
    const result = await driver.query(sql, params);
    return result.rowCount;
  };

  return {
    tableName: table,
    select,
    count,
    insert,
    update,
    delete: del,
  };
}
