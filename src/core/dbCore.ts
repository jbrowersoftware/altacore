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

// 'and'/'or'/'exists'/'notExists' are reserved group keys at the top level of
// a Where<T>; columns with those names cannot be filtered via the property
// syntax and must be addressed inside a group instead.
type ReservedWhereKey = 'and' | 'or' | 'exists' | 'notExists';

type ColumnWhere<T> = {
  [K in keyof T as K extends ReservedWhereKey ? never : K]?: WhereCondition<
    T[K]
  >;
};

/* eslint-disable @typescript-eslint/no-explicit-any */
// A correlated [NOT] EXISTS subquery. `on` correlates outer column(s) with the
// subquery's; `where` adds further filters scoped to the sub-table. The sub-row
// type `S` is open (defaults to `any` in `Where`, mirroring how `AnyJoin`
// leaves the joined row open) so the outer side stays typed (`keyof T`).
export type ExistsSpec<T, S> = {
  table: DbCore<S>;
  on:
    | readonly [keyof T & string, keyof S & string]
    | readonly (readonly [keyof T & string, keyof S & string])[];
  where?: Where<S>;
};

export type Where<T> = ColumnWhere<T> & {
  and?: readonly Where<T>[];
  or?: readonly Where<T>[];
  exists?: ExistsSpec<T, any> | readonly ExistsSpec<T, any>[];
  notExists?: ExistsSpec<T, any> | readonly ExistsSpec<T, any>[];
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// -----------------------------------------------------------------------------
// Column references & expressions
// -----------------------------------------------------------------------------
// `M` is an alias→row map ({ [alias]: joinedRow }) derived from the joins on
// the same call (see AliasMapOf below). When there are no joins it is the
// empty map, so only outer-table refs are allowed — preserving single-table
// behavior. A ColRef points at either an outer-table column (`{ col }`) or a
// joined column (`{ alias, col }`); an Expr additionally allows a portable
// COALESCE fallback, used for nullable-column ordering / keyset cursors.

// `keyof EmptyAliasMap` is `never`, so the joined-ref branch of ColRef
// collapses to `never` and only `{ col }` remains.
type EmptyAliasMap = Record<never, never>;

export type ColRef<T, M = EmptyAliasMap> =
  | { col: keyof T & string }
  | {
      [A in keyof M]: { alias: A & string; col: keyof M[A] & string };
    }[keyof M];

export type Expr<T, M = EmptyAliasMap> =
  | ColRef<T, M>
  | { coalesce: readonly [ColRef<T, M>, string | number | boolean] };

export type OrderBy<T, M = EmptyAliasMap> = Expr<T, M> & {
  direction?: 'asc' | 'desc';
};

// Keyset (cursor) pagination. `keys` are the ordered sort expressions — they
// may span the outer table and joined aliases, and use COALESCE for nullable
// columns. `after` carries one cursor value per key (the last row of the
// previous page). The same keys drive both the seek predicate and ORDER BY,
// so the two can never disagree. `limit` caps the page; keyset cannot be
// combined with the offset-based `limit`/`offset`.
export type KeysetKey<T, M = EmptyAliasMap> = {
  expr: Expr<T, M>;
  direction?: 'asc' | 'desc';
};

export type Keyset<T, M = EmptyAliasMap> = {
  keys: readonly KeysetKey<T, M>[];
  after: readonly unknown[];
  limit?: number;
};

// Aggregate output column. `as` names the result-row key. COUNT may take `'*'`
// or a column expression (with optional DISTINCT); sum/avg/min/max take a
// column expression; stringAgg joins values with `separator` (STRING_AGG on
// pg/mssql, GROUP_CONCAT on mysql). All are standard SQL across the three
// dialects. (Ordered/DISTINCT string aggregation is not yet supported.)
export type Aggregate<T, M = EmptyAliasMap> =
  | { fn: 'count'; arg: '*' | Expr<T, M>; distinct?: boolean; as: string }
  | { fn: 'sum' | 'avg' | 'min' | 'max'; arg: Expr<T, M>; as: string }
  | { fn: 'stringAgg'; arg: Expr<T, M>; separator: string; as: string };

export type SelectOptions<T, M = EmptyAliasMap> = {
  where?: Where<T>;
  limit?: number;
  offset?: number;
  orderBy?: OrderBy<T, M> | OrderBy<T, M>[];
  // Project a subset of columns. Omit to SELECT *.
  columns?: readonly (keyof T & string)[];
  // Group rows for aggregate queries. Refs may target the outer table or any
  // joined alias on the same call.
  groupBy?: Expr<T, M> | readonly Expr<T, M>[];
  // Keyset/cursor pagination — mutually exclusive with limit/offset.
  keyset?: Keyset<T, M>;
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
// `C` omitted (no `select.columns`) → the join projects nothing, contributing
// an empty entry to the result row. Such joins exist only to be referenced by
// ON/where/aggregates (e.g. STRING_AGG over an unprojected joined column).
type ProjectColumns<R, C> = C extends readonly (infer K)[]
  ? [K] extends [keyof R]
    ? Pick<R, K>
    : never
  : Record<never, never>;

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

// Alias→row map for ColRef/Expr targeting. Exposes the FULL joined row (not
// just `select.columns`): orderBy/groupBy/keyset/aggregate refs may address any
// column of a joined table regardless of what's projected — e.g. STRING_AGG
// over a joined column that isn't returned per-row. No LEFT/FULL `Optional`
// wrapper, since a ref addresses the column whether or not the row is present.
type AliasMapEntry<J> = J extends JoinSpec<any, infer R, infer A>
  ? { [K in A]: R }
  : {};

export type AliasMapOf<J> = J extends readonly AnyJoin<any>[]
  ? UnionToIntersection<{ [I in keyof J]: AliasMapEntry<J[I]> }[number]>
  : AliasMapEntry<J>;

// Output value type of one aggregate. count/sum/avg are numeric; min/max
// preserve the column type for a plain outer-column arg (e.g. a Date stays a
// Date), falling back to `unknown` for aliased/coalesced args we can't resolve.
type AggValue<T, Item> = Item extends { fn: 'count' | 'sum' | 'avg' }
  ? number
  : Item extends { fn: 'stringAgg' }
    ? string
    : Item extends { fn: 'min' | 'max'; arg: { col: infer C } }
      ? C extends keyof T
        ? T[C]
        : unknown
      : unknown;

// Maps an aggregates tuple to `{ [as]: value }`. Empty tuple → identity (`{}`)
// so the non-aggregated overloads keep returning exactly their row type.
type AggregateOut<T, A> = A extends readonly []
  ? EmptyAliasMap
  : A extends readonly (infer Item)[]
    ? UnionToIntersection<
        Item extends { as: infer N extends string }
          ? { [K in N]: AggValue<T, Item> }
          : never
      >
    : EmptyAliasMap;
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
  // Single join object. `AliasMapOf<J>` is threaded into the options so
  // orderBy/groupBy/keyset/aggregate refs can target the joined alias by name.
  // `A` captures the aggregates tuple so each `as` becomes a typed row key.
  <
    K extends keyof T & string,
    const J extends AnyJoin<T>,
    const A extends readonly Aggregate<T, AliasMapOf<J>>[] = readonly [],
  >(
    options: SelectOptions<T, AliasMapOf<J>> & {
      columns?: readonly K[];
      join: J;
      aggregates?: A;
    },
  ): Promise<Array<OuterRow<T, K> & JoinAliasEntry<J> & AggregateOut<T, A>>>;

  // Array of joins.
  <
    K extends keyof T & string,
    const J extends readonly AnyJoin<T>[],
    const A extends readonly Aggregate<T, AliasMapOf<J>>[] = readonly [],
  >(
    options: SelectOptions<T, AliasMapOf<J>> & {
      columns?: readonly K[];
      join: J;
      aggregates?: A;
    },
  ): Promise<Array<OuterRow<T, K> & AllJoinEntries<J> & AggregateOut<T, A>>>;

  // No-join, with column projection.
  <
    K extends keyof T & string,
    const A extends readonly Aggregate<T>[] = readonly [],
  >(
    options: SelectOptions<T> & { columns: readonly K[]; aggregates?: A },
  ): Promise<Array<Pick<T, K> & AggregateOut<T, A>>>;

  // No-join, no projection.
  <const A extends readonly Aggregate<T>[] = readonly []>(
    options?: SelectOptions<T> & { aggregates?: A },
  ): Promise<Array<T & AggregateOut<T, A>>>;
};

// Mirrors SelectFn<T> but wraps each row array in `{ rows; total }`. `total`
// is the count of rows matching the same where/join with limit/offset
// dropped — for 1:0..1 joins it equals the outer-row count; for 1:N joins
// it counts join-result rows (same as count() over a join).
export type SelectWithCountFn<T> = {
  // Single join object.
  <
    K extends keyof T & string,
    const J extends AnyJoin<T>,
    const A extends readonly Aggregate<T, AliasMapOf<J>>[] = readonly [],
  >(
    options: SelectOptions<T, AliasMapOf<J>> & {
      columns?: readonly K[];
      join: J;
      aggregates?: A;
    },
  ): Promise<{
    rows: Array<OuterRow<T, K> & JoinAliasEntry<J> & AggregateOut<T, A>>;
    total: number;
  }>;

  // Array of joins.
  <
    K extends keyof T & string,
    const J extends readonly AnyJoin<T>[],
    const A extends readonly Aggregate<T, AliasMapOf<J>>[] = readonly [],
  >(
    options: SelectOptions<T, AliasMapOf<J>> & {
      columns?: readonly K[];
      join: J;
      aggregates?: A;
    },
  ): Promise<{
    rows: Array<OuterRow<T, K> & AllJoinEntries<J> & AggregateOut<T, A>>;
    total: number;
  }>;

  // No-join, with column projection.
  <
    K extends keyof T & string,
    const A extends readonly Aggregate<T>[] = readonly [],
  >(
    options: SelectOptions<T> & { columns: readonly K[]; aggregates?: A },
  ): Promise<{ rows: Array<Pick<T, K> & AggregateOut<T, A>>; total: number }>;

  // No-join, no projection.
  <const A extends readonly Aggregate<T>[] = readonly []>(
    options?: SelectOptions<T> & { aggregates?: A },
  ): Promise<{ rows: Array<T & AggregateOut<T, A>>; total: number }>;
};

export type DbCore<T> = {
  // The SQL table name passed to createDbCore. Exposed because joins need
  // to reach through `JoinSpec.table` (a DbCore reference) to emit the
  // joined-table identifier; also useful for introspection.
  readonly tableName: string;
  select: SelectFn<T>;
  // Paginated select + total count in one call. Runs select() and count()
  // in parallel over the same where/join (count drops limit/offset).
  selectWithCount: SelectWithCountFn<T>;
  count: (options?: CountOptions<T>) => Promise<number>;
  insert: (values: Partial<T>) => Promise<T>;
  update: (options: UpdateOptions<T>) => Promise<T[]>;
  delete: (options: DeleteOptions<T>) => Promise<number>;
};

const NUMERIC_AGG_FNS: ReadonlySet<string> = new Set(['count', 'sum', 'avg']);

// In place, coerce count/sum/avg outputs from driver-native strings (pg's
// bigint/numeric) to numbers. Aggregate `as` keys are top-level on every row
// (joined or flat), so this runs after nesting.
function coerceNumericAggregates(
  rows: Array<Record<string, unknown>>,
  aggregates: ReadonlyArray<{ fn: string; as: string }> | undefined,
): void {
  const numericKeys = (aggregates ?? [])
    .filter((a) => NUMERIC_AGG_FNS.has(a.fn))
    .map((a) => a.as);
  if (numericKeys.length === 0) return;
  for (const row of rows) {
    for (const key of numericKeys) {
      const v = row[key];
      if (v !== null && v !== undefined) row[key] = Number(v);
    }
  }
}

export function createDbCore<T>(db: Database, table: string): DbCore<T> {
  const driver = db.driver;
  const dialect = driver.dialect;

  const supportsReturn = dialect.returningStrategy !== 'none';

  // The single-signature implementation is shared between `select` and
  // `selectWithCount`. The overloads on SelectFn/SelectWithCountFn narrow
  // the return type at the call site; `SelectInput<T>` widens options to
  // include `join?` so the runtime can read it. Casts at assignment
  // restore each public multi-overload type.
  const doSelect = async (options?: SelectInput<T>) => {
    const joins = options?.join;
    // Normally every join must project columns. But in an aggregate/grouped
    // query a join may exist purely to feed an aggregate (e.g. STRING_AGG over
    // a joined column) and project nothing — so columns can't be grouped and
    // must be omitted. Skip the projection requirement in that case.
    if (joins && !options?.aggregates && !options?.groupBy) {
      assertJoinColumns(joins);
    }
    const { sql, params } = buildSelect<T>(table, dialect, options);
    const result = await driver.query<Record<string, unknown>>(sql, params);
    const rows = joins
      ? result.rows.map((r) => nestJoinedRow(r, joins))
      : result.rows;
    // Same rationale as count(): pg returns COUNT/SUM/AVG as bigint/numeric
    // strings. Coerce those aggregate outputs to numbers (their typed result
    // shape). min/max are left as-is — they preserve the source column type.
    if (options?.aggregates) coerceNumericAggregates(rows, options.aggregates);
    return rows as unknown as T[];
  };

  const select = doSelect as unknown as SelectFn<T>;

  const count = async (options?: CountOptions<T>): Promise<number> => {
    const { sql, params } = buildCount<T>(table, dialect, options);
    const result = await driver.query<{ count: number | string }>(sql, params);
    // pg returns COUNT(*) as a bigint string; coerce so consumers get a number.
    return Number(result.rows[0]?.count ?? 0);
  };

  const selectWithCount = (async (options?: SelectInput<T>) => {
    // The count must reflect the unpaginated set, so drop limit/offset.
    // where + join are preserved so the count matches the rows' filter.
    // Cast on `join`: the internal SelectInput widens it to AnyJoin<any>
    // for the runtime path; the value originally came in through a typed
    // SelectFn overload constrained to AnyJoin<T>, so the cast is sound.
    const countOpts: CountOptions<T> = {
      where: options?.where,
      join: options?.join as CountOptions<T>['join'],
    };
    const [rows, total] = await Promise.all([
      doSelect(options),
      count(countOpts),
    ]);
    return { rows, total };
  }) as unknown as SelectWithCountFn<T>;

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
    selectWithCount,
    count,
    insert,
    update,
    delete: del,
  };
}
