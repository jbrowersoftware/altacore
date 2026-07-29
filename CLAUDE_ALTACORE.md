# CLAUDE_ALTACORE.md — Altacore usage reference

Guidance for Claude Code when working in a project that **consumes the `altacore` npm package** (v0.2.x). This file is self-contained — everything needed to write correct Altacore code is here; do not read `node_modules/altacore`.

Altacore is a lightweight, functional, TypeScript-first ORM for **PostgreSQL (`pg`)**, **MySQL (`mysql2`)**, and **Microsoft SQL Server (`mssql`)**. One API across all three; drivers are optional peer dependencies (install only the one in use). Requires Node ≥ 20. Ships dual ESM/CJS with full `.d.ts` types. No classes, no decorators — factory functions and plain data only.

## Setup

```ts
import { createDatabase, createDbCore } from 'altacore';

const db = createDatabase({
  driver: 'pg', // 'pg' | 'mysql' | 'mssql'
  connectionString: process.env.DATABASE_URL!,
  pool: { max: 20, min: 2, idleTimeoutMillis: 30_000 }, // optional
});
```

- `createDatabase` is **synchronous**; the real driver module is dynamically imported and the connection established lazily on the first query. `await db.driver.close()` to shut down (idempotent).
- `pool` is deliberately minimal: `max` / `min` / `idleTimeoutMillis` only, forwarded to the driver (`min` is ignored on mysql — mysql2 has no minimum-idle). Anything fancier: construct the underlying driver directly.

## Modeling row types

One plain TS type per table; bind it with `createDbCore<T>(db, 'table_name')`.

```ts
type User = {
  id: number; // DB-generated is fine — insert takes Partial<T>
  email: string;
  active: boolean;
  age: number;
  bio?: string; // nullable column → use `?:`, NOT `| null`
};
const users = createDbCore<User>(db, 'users');
```

**SQL `NULL` becomes `undefined` in every returned row** (shallow — nulls inside JSON column values are preserved). So model nullable columns with `?:`. Convention in this codebase: type reads strictly (`T`, not `Partial<T>`); the consumer marks `?:`/nullable where the schema warrants it.

`createDbCore` takes an optional second type parameter and third argument for [hydration](#hydration-fetching-fk-related-records): `createDbCore<User, UserHydration>(db, 'users', { hydration: {...} })`.

## `DbCore<T, H = {}>` surface

```ts
{
  readonly tableName: string;
  select(options?): Promise<T[]>;                       // overloads narrow — see below
  selectWithCount(options?): Promise<{ rows; total }>;  // select + count in parallel
  count(options?): Promise<number>;
  insert(values: Partial<T>): Promise<T>;
  update({ where, set: Partial<T> }): Promise<T[]>;
  delete({ where }): Promise<number>;                   // affected row count
}
```

### Per-driver return-shape differences (important)

| Call     | pg                                                                        | mssql                        | mysql                                                                                             |
| -------- | ------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `insert` | full DB row via `RETURNING *` (defaults/autogen/trigger values reflected) | same via `OUTPUT INSERTED.*` | **echoes your input** — unsupplied fields are absent; `select` afterward if you need the full row |
| `update` | post-update rows `T[]`                                                    | same                         | **always `[]`** — query separately if you need rows back                                          |
| `delete` | affected count                                                            | affected count               | affected count                                                                                    |

`count()` always returns a `number` (pg's bigint string is coerced). Numeric aggregate outputs (`count`/`sum`/`avg`) are likewise coerced to `number`.

### Safety guards (throw at runtime)

- `update` / `delete` with an empty `where` (`{}`) throws — no accidental full-table writes.
- `insert` requires at least one defined column.
- Every join used with `select()` must supply `select.columns` (exception: aggregate-feeder joins, below).

## `select` options

```ts
users.select({
  where?: Where<T>,
  columns?: ['id', 'email'],        // narrows return to Pick<T, K>[]; omit = SELECT *; empty array rejected
  orderBy?: OrderBy | OrderBy[],    // { col, direction? } — direction defaults 'asc'
  limit?: number,
  offset?: number,
  join?: JoinSpec | JoinSpec[],
  groupBy?: Expr | Expr[],
  aggregates?: Aggregate[],
  keyset?: Keyset,                  // mutually exclusive with limit/offset
  hydrate?: ['org', ...],           // keys of H — see Hydration section
});
```

Return types are fully inferred — column projection, join nesting, and aggregate keys all show up in the row type without `as const`.

## Where clauses

Each field takes a bare value (equality) or an operator object. Fields AND together; operators on one field AND together.

```ts
where: {
  active: true,                       // "active" = $1
  age: { gt: 18, lte: 65 },
  email: { like: '%@example.com' },   // like: string columns only (typed away otherwise)
  bio: null,                          // IS NULL  (also: { eq: null } / { ne: null } → IS NOT NULL)
  status: { in: ['a', 'b'] },         // empty in-array → always-false (1=0); empty nin → always-true
}
```

Operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`. There is **no `not`** operator yet.

**Reserved top-level keys** in `where`: `and`, `or`, `exists`, `notExists`. Columns literally named these can't use the property syntax — wrap them in a group.

### Grouping

```ts
where: {
  active: true,
  or: [
    { email: { like: '%@example.com' } },
    { and: [{ age: { gt: 65 } }, { bio: { ne: null } }] },
  ],
}
```

Groups nest arbitrarily. Empty groups/branches (`or: []`) are silently skipped — safe to build conditionally.

### EXISTS / NOT EXISTS (cross-table filtering without a join)

```ts
where: {
  active: true,
  exists: {                       // or notExists; single spec or array
    table: orders,                // a DbCore<S>
    on: ['id', 'userId'],         // [outerCol, subCol]; array of pairs for multi-column
    where: { status: 'paid' },    // scoped to the subquery table
  },
}
// … AND EXISTS (SELECT 1 FROM "orders" AS "_ex0" WHERE "_ex0"."userId" = "users"."id" AND …)
```

This is the correct way to filter outer rows by a related table — **outer `where` cannot reference joined columns.**

## Joins

```ts
const out = await users.select({
  columns: ['id', 'email'],
  join: {
    table: orders,               // DbCore<R> for the joined table
    type: 'left',                // 'inner' (default) | 'left' | 'right' | 'full'
    alias: 'o',                  // nested key on each result row
    on: ['id', 'userId'],        // [outerCol, joinedCol]; array of pairs → multi-column ON (AND-ed)
    select: {
      columns: ['id', 'total'],  // REQUIRED for select() joins (projects the joined row)
      where: { status: 'paid' }, // ⚠ AND-ed into the ON clause — NOT the outer WHERE
      join: { ... },             // nested joins recurse here
    },
  },
});
// out: Array<{ id: number; email: string; o: { id: number; total: number } | undefined }>
```

Key semantics:

- **Result rows nest by alias**: each join contributes `{ [alias]: projectedRow }`. LEFT/FULL with no match → that slot is `undefined` (type includes `| undefined`).
- **`select.where` lands in the ON clause, not outer WHERE.** This is deliberate: putting it in WHERE would silently turn a LEFT join into an INNER one (NULL comparisons drop unmatched outer rows). If you actually want "only outer rows with a matching-and-filtered joined row," use `type: 'inner'`.
- `join` accepts an array for multiple parallel joins off the outer table; nest via `select.join` for chains.
- `count({ join })` accepts the same shape, ignores projections (columns may be omitted there), and **counts join-result rows** — a user with 3 matching orders contributes 3.
- Don't join on tables whose column names contain a literal `.` — the result mapper splits on dots to nest.
- **1:N joins duplicate outer rows** in the result (one result row per joined match; the alias slot holds a single row, never an array). Array-shaped joined data is not modeled. Collapse 1:N with `groupBy` + aggregates instead.

### Pagination + join

`limit`/`offset` with `join` subquery-wraps the outer table, so the page counts **outer rows**, not join-expanded rows ("first 10 users with their orders", not "first 10 user-order pairs"). With 1:N joins, `result.length` may still exceed `limit`. Caveat: alias-qualified `orderBy` entries can't influence which outer rows land on the page (the alias doesn't exist inside the pagination subquery) — if the page selection must be ordered by a joined column, use keyset pagination.

## Hydration (fetching FK-related records)

Fetches **single related records reached through an FK on this table** (many-to-one / one-to-one) without a join. One-to-many ("lists") is deliberately not modeled — fetch child rows with their own select on the child table, or collapse with `groupBy` + aggregates.

```ts
type Org = { id: number; name: string };
type User = { id: number; email: string; orgId: number; managerId?: number };
type UserHydration = { org: Org; manager?: User }; // key optional ⟺ FK nullable

const orgs = createDbCore<Org>(db, 'orgs');
const users: DbCore<User, UserHydration> = createDbCore<User, UserHydration>(
  db,
  'users',
  {
    hydration: {
      org: { table: orgs, on: ['orgId', 'id'] }, // on: [fkCol, targetCol]
      manager: { table: () => users, on: ['managerId', 'id'] }, // thunk for self/circular refs
    },
  },
);

const out = await users.select({ hydrate: ['org'] });
// out: Array<User & { org: Org }> — only requested keys land on the row
out[0]?.manager; // type error — not hydrated on this call
```

Semantics:

- One batched lookup per requested key (`SELECT * FROM orgs WHERE id IN (<distinct FK values>)`) **after** the main query; matches are grafted onto rows. No join → no row duplication; composes unchanged with `limit`/`offset`, `keyset`, `join`, `columns`, and `selectWithCount` (hydrates `rows`, `total` unaffected).
- Hydrated slots hold the **full related row**. NULL FK or unmatched FK → key absent; declare the key `?:` in `H` for that case.
- Rows sharing an FK value share the **same related object** — don't mutate it per-row.
- Every key declared in `H` must be wired in the `hydration` spec (compile-enforced when the spec is passed).
- Throws before any SQL: `hydrate` key with no configured relation; `columns` projection that drops the relation's FK column. Also throws if a hydration key collides with an existing row property (column or join alias).

## Column references / expressions

`orderBy`, `groupBy`, keyset keys, and aggregate args take references, not bare names:

- `{ col: 'age' }` — outer-table column
- `{ alias: 'o', col: 'total' }` — joined column, type-checked against the call's joins; may target **any** joined column, even unprojected ones
- `{ coalesce: [ref, fallback] }` — portable `COALESCE(col, fallback)` for nullable columns, usable anywhere a ref is

```ts
orderBy: [
  { alias: 'o', col: 'total', direction: 'desc' },
  { coalesce: [{ col: 'bio' }, ''] }, // direction defaults 'asc'
];
```

MSSQL note: `limit`/`offset` without `orderBy` gets a synthetic `ORDER BY (SELECT NULL)` — pagination order is then engine-chosen. Supply an explicit `orderBy` for stable pages.

## Grouping and aggregates

```ts
const byStatus = await users.select({
  columns: ['status'],
  groupBy: { col: 'status' },
  aggregates: [{ fn: 'count', arg: '*', as: 'n' }],
});
// rows: Array<{ status: string; n: number }>
```

Aggregates (each `as` becomes a typed result key):

- `{ fn: 'count', arg: '*' | ref, distinct?: true, as }` → `number`
- `{ fn: 'sum' | 'avg', arg: ref, as }` → `number`
- `{ fn: 'min' | 'max', arg: ref, as }` → the column's type (plain outer-column arg; `unknown` otherwise)
- `{ fn: 'stringAgg', arg: ref, separator: ', ', as }` → `string` (STRING_AGG on pg/mssql, GROUP_CONCAT on mysql)

An **aggregate-feeder join** may omit `select.columns` entirely — it projects nothing, needs no `GROUP BY` entry, contributes no nested key, and exists only so aggregates/refs can address it:

```ts
const usersWithRoles = await users.select({
  columns: ['id', 'email'],
  join: { table: roles, type: 'left', alias: 'r', on: ['id', 'userId'] }, // no select.columns
  aggregates: [
    {
      fn: 'stringAgg',
      arg: { alias: 'r', col: 'name' },
      separator: ', ',
      as: 'roles',
    },
  ],
  groupBy: [{ col: 'id' }, { col: 'email' }],
});
// rows: Array<{ id: number; email: string; roles: string }>
```

Not yet supported: ordered / DISTINCT string aggregation; `count()` of grouped rows (it's always a scalar `COUNT(*)`).

## Keyset (cursor) pagination

Preferred for deep or "load more" pagination. Mutually exclusive with `limit`/`offset` (carries its own `limit`). The same `keys` drive both the seek predicate and `ORDER BY`, so they can't disagree; the predicate is expanded lexicographic form, portable to all three dialects.

```ts
const page = await users.select({
  columns: ['id', 'email', 'age'],
  keyset: {
    keys: [
      { expr: { col: 'age' }, direction: 'asc' },
      { expr: { col: 'id' }, direction: 'asc' }, // always include a unique tiebreaker
    ],
    after: [lastRow.age, lastRow.id], // one cursor value per key; start-of-sequence values for page 1
    limit: 25,
  },
});
```

Keys may span joined aliases (`{ alias, col }`) and use `coalesce` for nullable columns. Unlike offset pagination over joins, keyset pages the **joined result set directly** (flat emission) — it's the right tool when the cursor's primary sort is a joined column.

## Paginated select + total

```ts
const { rows, total } = await users.selectWithCount({
  where: { active: true },
  orderBy: { col: 'id' },
  limit: 25,
  offset: page * 25,
});
```

Runs `select` and `count` in parallel over the same `where` + `join`, with `limit`/`offset` dropped from the count. Overloads mirror `select` exactly (projection narrows `rows`, joins nest). With 1:N joins, `total` counts join-result rows, not distinct outer rows.

## Raw SQL escape hatch

```ts
const result = await db.driver.query<{ id: number }>(
  'SELECT id FROM users WHERE active = $1', // placeholders: $1 pg, ? mysql, @p1 mssql
  [true],
);
// result: { rows: R[]; rowCount: number }  — rowCount is affected rows for writes
db.driver.dialect.quoteIdentifier('users'); // "users" / `users` / [users]
db.driver.dialect.placeholder(1); // '$1' / '?' / '@p1'
```

`db.driver.query` also applies the null→undefined row normalization.

## Public exports

Values: `createDatabase`, `createDbCore`, `VERSION`.
Types: `Database`, `DatabaseConfig`, `DatabaseDriver`, `PoolConfig`, `DbCore`, `CreateDbCoreOptions`, `HydrationRelation`, `HydrationSpec`, `SelectOptions`, `CountOptions`, `UpdateOptions`, `DeleteOptions`, `Where`, `WhereCondition`, `WhereOperators`, `ExistsSpec`, `ColRef`, `Expr`, `OrderBy`, `Keyset`, `KeysetKey`, `Aggregate`, `JoinType`, `OnPair`, `OnSpec`, `JoinSelect`, `JoinSpec`, `AnyJoin`, `SelectFn`, `SelectWithCountFn`, `Driver`, `DriverFactory`, `QueryResult`.

Anything not in that list is internal and may change without a major bump. Do not mock `DbCore<T>` by hand-rolling partial objects — the shape includes `tableName` and `selectWithCount`; prefer building through `createDbCore` or typing mocks against `DbCore<T>` so additions surface as type errors.

## Quick gotcha checklist

1. Nullable columns → `?:` in the row type; returned rows use `undefined`, never `null`.
2. mysql: `insert` echoes input (missing fields absent), `update` returns `[]`.
3. Join `select.where` filters the **ON clause** — it does not remove outer rows on LEFT/FULL joins; use `type: 'inner'` or `exists` for that.
4. Outer `where` can't reference joined columns — use `exists`/`notExists`.
5. Every `select()` join needs `select.columns`, except aggregate-feeder joins.
6. `keyset` and `limit`/`offset` are mutually exclusive.
7. `count()` over a join counts join-expanded rows; so does `selectWithCount`'s `total`.
8. 1:N joined data is never array-shaped — rows duplicate; collapse with `groupBy` + aggregates.
9. `and`/`or`/`exists`/`notExists` are reserved `where` keys.
10. On MSSQL, always pass `orderBy` when paginating if you need stable pages.
11. `hydrate` is for single FK-related records only — never lists; the FK column must survive a `columns` projection.
12. Hydration keys must not share a name with a column or join alias on the same call — that throws.
