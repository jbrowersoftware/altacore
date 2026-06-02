# Altacore

A lightweight, easy-to-use ORM framework for Node.js applications working with **Microsoft SQL Server**, **MySQL**, and **PostgreSQL**.

> **Status:** pre-1.0, in active development. Typed CRUD, joins, aggregates, and keyset pagination work today across all three drivers — see the [`createDbCore` reference](#createdbcore-reference) for the full surface.

## Why Altacore

Altacore aims for the middle ground between hand-rolled query builders and heavyweight, opinionated ORMs — a small functional API that gives you typed queries and connection management without the abstraction cost.

- **Lightweight** — minimal runtime, no decorators, no metadata reflection
- **Functional** — factory functions and plain data, not classes or inheritance
- **Multi-database** — one API across SQL Server, MySQL, and PostgreSQL
- **TypeScript-first** — full type definitions, ESM and CJS shipped side by side

## Supported databases

| Database             | Driver (peer dependency)                         | Status |
| -------------------- | ------------------------------------------------ | ------ |
| Microsoft SQL Server | [`mssql`](https://www.npmjs.com/package/mssql)   | Wired  |
| MySQL                | [`mysql2`](https://www.npmjs.com/package/mysql2) | Wired  |
| PostgreSQL           | [`pg`](https://www.npmjs.com/package/pg)         | Wired  |

Drivers are optional peer dependencies — install only the one you use.

## Requirements

- Node.js 20 or later

## Installation

```bash
npm install altacore

# Install the driver(s) you actually use:
npm install mssql      # for Microsoft SQL Server
npm install mysql2     # for MySQL
npm install pg         # for PostgreSQL
```

## Quick start

The heart of Altacore is **`createDbCore`** — a typed CRUD core bound to one table. Define a row type once, then `select` / `count` / `insert` / `update` / `delete` with full type inference.

```ts
import { createDatabase, createDbCore } from 'altacore';

type User = {
  id: number; // DB-supplied; insert accepts Partial<User> so you can omit it
  email: string;
  active: boolean;
  age: number;
  bio?: string;
};

const db = createDatabase({
  driver: 'pg',
  connectionString: process.env.DATABASE_URL!,
});

const users = createDbCore<User>(db, 'users');

// SELECT with typed where + ordering + limit
const found = await users.select({
  where: {
    active: true, // bare value = equality
    age: { gt: 18, lte: 65 }, // operators AND-ed per field
    email: { like: '%@example.com' },
  },
  orderBy: { col: 'age', direction: 'desc' },
  limit: 10,
});

// COUNT — returns a number; same where syntax as select
const activeAdults = await users.count({
  where: { active: true, age: { gte: 18 } },
});

// JOIN — typed multi-table query with nested-by-alias result rows
type Order = { id: number; userId: number; total: number; status: string };
const orders = createDbCore<Order>(db, 'orders');

const usersWithLatestPaidOrder = await users.select({
  columns: ['id', 'email'],
  join: {
    table: orders,
    type: 'left',
    alias: 'o',
    on: ['id', 'userId'],
    select: {
      columns: ['id', 'total'],
      where: { status: 'paid' }, // AND-ed into ON, not outer WHERE
    },
  },
});
// Each row: { id, email, o: { id, total } | undefined }

// PAGINATED select + total in one call — runs the page query and the count
// query in parallel (count drops limit/offset). Useful for paginated UIs.
const { rows, total } = await users.selectWithCount({
  where: { active: true },
  orderBy: { col: 'id' },
  limit: 25,
  offset: 0,
});
// rows: User[] (first 25 active users), total: total active-user count

// INSERT — returns the inserted row (pg/mssql) or echoes input (mysql)
const created = await users.insert({
  email: 'a@b.com',
  active: true,
  age: 30,
});

// UPDATE — returns post-update rows on pg/mssql, [] on mysql
await users.update({
  where: { id: 1 },
  set: { active: false },
});

// DELETE — returns affected row count
const removed = await users.delete({ where: { id: 1 } });
```

## `createDbCore` reference

### Selecting rows

`select(options?)` returns `T[]`. With `columns` supplied, the return type narrows to `Pick<T, K>[]`:

```ts
// Full row — typed as User[]
const all = await users.select({ where: { active: true } });

// Projected row — typed as Pick<User, 'id' | 'email'>[]
const slim = await users.select({
  where: { active: true },
  columns: ['id', 'email'],
});

slim[0]?.email; // ok
slim[0]?.age; // type error — 'age' was not selected
```

`columns` accepts any `keyof T & string`, so you get autocomplete and refactoring safety. Empty arrays are rejected — omit the property to `SELECT *`.

### Counting rows

`count(options?)` issues `SELECT COUNT(*)` and returns a plain `number`. It accepts the same `where` syntax as `select`; omit `where` (or omit `options` entirely) to count every row.

```ts
const total = await users.count();
const active = await users.count({ where: { active: true } });
```

PostgreSQL returns `COUNT(*)` as a bigint string at the driver layer; Altacore coerces it so you always get a `number`.

### Paginated select with total count

`selectWithCount(options?)` runs the same arguments through `select` and `count` in parallel and returns `{ rows, total }`. The count query drops `limit` and `offset` so `total` is the unpaginated count; `where`, `join`, and the rest are honored on both sides.

```ts
const { rows, total } = await users.selectWithCount({
  where: { active: true },
  orderBy: { col: 'id' },
  limit: 25,
  offset: page * 25,
});
// rows: User[] (≤25 entries), total: total active users for pagination UI
```

Overloads mirror `select` end-to-end: column projection narrows `rows`, joins nest by alias under `rows`, the return is still `{ rows, total }`.

```ts
const { rows, total } = await users.selectWithCount({
  columns: ['id', 'email'],
  join: {
    table: orders,
    type: 'left',
    alias: 'o',
    on: ['id', 'userId'],
    select: { columns: ['id', 'total'] },
  },
  limit: 10,
});
// rows: Array<{ id; email; o: { id; total } | undefined }>, total: number
```

When `limit` / `offset` are combined with `join`, Altacore subquery-wraps the outer table so pagination applies to **outer rows**, not join-expanded result rows — see the "Joining tables" section for the LEFT/INNER detail and the 1:N caveat that affects `total`.

### Joining tables

`select` (and `count`) accept a `join` option — a single `JoinSpec` or an array. Each join contributes `{ [alias]: <projected joined row> }` onto the result. For LEFT/FULL joins with no match, the joined slot is `undefined`.

#### Anatomy of a join

```ts
type User = { id: number; email: string; tenantId: number };
type Order = { id: number; userId: number; total: number; status: string };

const users = createDbCore<User>(db, 'users');
const orders = createDbCore<Order>(db, 'orders');

const out = await users.select({
  columns: ['id', 'email'],
  join: {
    table: orders, // DbCore<R> reference — the target of the join
    type: 'left', // 'inner' (default) | 'left' | 'right' | 'full'
    alias: 'o', // names the nested key in each row
    on: ['id', 'userId'], // [outerCol, joinedCol]
    select: {
      columns: ['id', 'total'], // required — projects the joined row
      where: { status: 'paid' }, // AND-ed into the ON clause (see below)
    },
  },
});
// out: Array<{ id: number; email: string; o: { id: number; total: number } | undefined }>
```

The return type is computed end-to-end — column projection narrows the joined row to `Pick<R, K>`, the alias becomes a literal key on the result, and LEFT/FULL widens the joined slot to `| undefined`.

#### Multi-column ON

Pass an array of pairs; they AND together inside the ON clause.

```ts
join: {
  table: orders,
  alias: 'o',
  on: [
    ['id', 'userId'],
    ['tenantId', 'tenantId'],
  ],
  select: { columns: ['id'] },
}
// ON "users"."id" = "o"."userId" AND "users"."tenantId" = "o"."tenantId"
```

#### `where` inside `join.select` lands in the ON clause — not the outer WHERE

This is the single most important thing to internalize. `select.where` on a join is AND-ed into the SQL `ON` clause, **not** appended to the outer `WHERE`. The choice exists to preserve LEFT/FULL join semantics.

Setup:

```ts
// users:  [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }, { id: 3, name: 'Carol' }]
// orders: [
//   { id: 10, userId: 1, total: 100, status: 'paid' },
//   { id: 11, userId: 1, total: 50,  status: 'pending' },
//   { id: 12, userId: 2, total: 200, status: 'paid' },
//   // Carol has no orders
// ]

await users.select({
  join: {
    table: orders,
    type: 'left',
    alias: 'o',
    on: ['id', 'userId'],
    select: { columns: ['id', 'total'], where: { status: 'paid' } },
  },
});
```

Emitted SQL:

```sql
SELECT ...
FROM "users"
LEFT JOIN "orders" AS "o"
  ON "users"."id" = "o"."userId"
  AND "o"."status" = $1
```

Result — **Carol is preserved**:

```ts
[
  { id: 1, name: 'Alice', o: { id: 10, total: 100 } },
  { id: 2, name: 'Bob', o: { id: 12, total: 200 } },
  { id: 3, name: 'Carol', o: undefined },
];
```

The footgun this prevents: if the predicate landed in outer WHERE instead (`WHERE o.status = 'paid'`), `o.status` would be `NULL` for Carol, `NULL = 'paid'` evaluates to `UNKNOWN`, and the WHERE drops her — silently converting the LEFT JOIN into an INNER JOIN. Altacore picks the ON placement so the type of join you wrote is the type of join you get.

When you actually want "only users who have ≥1 paid order" (i.e., drop Carol), switch the join to `type: 'inner'` — that makes the intent legible at the call site.

#### Nested joins

Recurse via `select.join`. The nested join's ON references the immediate parent's alias; result keys follow the full alias path.

```ts
await users.select({
  columns: ['id', 'email'],
  join: {
    table: orders,
    alias: 'o',
    on: ['id', 'userId'],
    select: {
      columns: ['id', 'total'],
      join: {
        table: items,
        alias: 'it',
        on: ['id', 'orderId'],
        select: { columns: ['sku'] },
      },
    },
  },
});
// Each row: { id, email, o: { id, total, it: { sku } } }
```

#### Multiple parallel joins

`join` accepts an array. Each element is an independent join off the outer table.

```ts
await users.select({
  columns: ['id'],
  join: [
    {
      table: orders,
      alias: 'o',
      on: ['id', 'userId'],
      select: { columns: ['total'] },
    },
    {
      table: profile,
      alias: 'p',
      type: 'left',
      on: ['id', 'userId'],
      select: { columns: ['bio'] },
    },
  ],
});
// Each row: { id, o: { total }, p: { bio } | undefined }
```

#### Pagination over joins

When `limit` / `offset` are combined with `join`, Altacore wraps the outer table in a derived subquery so the page applies to **outer rows**, not join-expanded result rows. This is the difference between "first 10 users (with all their joined data)" and "first 10 user-order pairs."

```ts
await users.select({
  columns: ['id'],
  where: { active: true },
  orderBy: { col: 'id' },
  join: {
    table: orders,
    type: 'left',
    alias: 'o',
    on: ['id', 'userId'],
    select: { columns: ['id', 'total'] },
  },
  limit: 10,
});
```

Emitted SQL (pg):

```sql
SELECT "page"."id", "o"."id" AS "o.id", "o"."total" AS "o.total"
FROM (
  SELECT * FROM "users" WHERE "active" = $1 ORDER BY "id" ASC LIMIT 10
) AS "page"
LEFT JOIN "orders" AS "o" ON "page"."id" = "o"."userId"
ORDER BY "page"."id" ASC
```

The inner subquery drives the pagination; the outer `ORDER BY` keeps result rows in the same outer order after the join's row expansion. For LEFT/FULL joins, each of the 10 outer rows appears once (with or without joined data). For INNER joins, outer rows whose join doesn't match are filtered, so a page may contain fewer than 10 outer rows.

#### `count` with joins

`count()` accepts the same `join` shape. Projections are ignored — only the JOIN/ON/WHERE structure affects the count.

```ts
const paidUsers = await users.count({
  join: {
    table: orders,
    alias: 'o',
    on: ['id', 'userId'],
    select: { where: { status: 'paid' } }, // columns can be omitted here
  },
});
// SELECT COUNT(*) FROM users INNER JOIN orders o ON ... AND o.status = $1
```

Note: `COUNT(*)` over a join counts joined rows. A user with three paid orders contributes three to the count — same as raw SQL.

#### Constraints and gotchas

- **`select.columns` is required on every join used with `select()`** — except a join that exists purely to feed an aggregate or group (see [Grouping and aggregates](#grouping-and-aggregates)), which may omit it to project nothing. Otherwise the SQL builder needs the column list to emit alias-qualified projections (`"o"."id" AS "o.id"`) so the result mapper can nest rows by dotted key; omitting it throws a clear runtime error. `count()` skips this requirement since it doesn't project.
- **`orderBy`, `groupBy`, keyset keys, and aggregate args can reference joined columns** via `{ alias, col }` (typed against the call's joins). But **plain outer `where` conditions are still outer-column-only** — for cross-table filtering use an [`EXISTS` subquery](#exists--not-exists-subqueries), or switch the join to `inner` when the goal is simply to drop unmatched outer rows.
- **Don't use column names containing `.`** when joining — the result mapper splits keys on dots to nest. Source columns with literal dots in their names will be misinterpreted.
- **1:N joins still duplicate outer rows in the result.** Altacore's nested-by-alias result shape carries a single joined row per alias slot, so a 1:N join produces multiple result rows that share an outer row (each pairing it with a different joined match). Pagination correctly limits **outer rows** in the subquery, but `result.length` can exceed your page size when 1:N expands. For the same reason, `count()` (and `selectWithCount`'s `total`) counts join-result rows, not distinct outer rows. If your domain is genuinely 1:N and you need array-shaped joined data, that's not modeled in v1. (Aggregating the 1:N side — e.g. `COUNT DISTINCT` or `STRING_AGG` with `groupBy` — collapses it back to one row per group; see [Grouping and aggregates](#grouping-and-aggregates).)

### Column references and expressions

Several options (`orderBy`, `groupBy`, keyset keys, aggregate args) accept a **column reference** rather than a bare column name. A reference is one of:

- `{ col: 'age' }` — a column on the outer table.
- `{ alias: 'o', col: 'total' }` — a column on a joined alias. The alias and column are type-checked against the joins on the same call, and may target **any** column of the joined table — even one that isn't projected.

Anywhere a reference is accepted you can also use a **`COALESCE` expression** for portable nullable handling (renders `COALESCE(col, fallback)` on all three dialects):

```ts
{
  coalesce: [{ col: 'bio' }, ''];
} // COALESCE("bio", $n)
{
  coalesce: [{ alias: 'o', col: 'total' }, 0];
} // COALESCE("o"."total", $n)
```

### Grouping and aggregates

`groupBy` takes one reference or an array; `aggregates` adds computed output columns. Each aggregate names a result key with `as`, and the return type gains that key — typed `number` for `count` / `sum` / `avg`, `string` for `stringAgg`, and the source column's type for `min` / `max`.

```ts
// Count active users per status
const byStatus = await users.select({
  columns: ['status'],
  groupBy: { col: 'status' },
  aggregates: [{ fn: 'count', arg: '*', as: 'n' }],
});
// rows: Array<{ status: string; n: number }>
// SELECT "status", COUNT(*) AS "n" FROM "users" GROUP BY "status"
```

Supported aggregates: `count` (with `arg: '*'` or a column reference, plus optional `distinct: true`), `sum` / `avg` / `min` / `max` (column reference), and `stringAgg` (joins values with a `separator` — `STRING_AGG` on pg/mssql, `GROUP_CONCAT(... SEPARATOR ...)` on mysql).

```ts
// COUNT DISTINCT of a joined column, grouped by the outer table
const deficienciesPerLocation = await locations.select({
  columns: ['id'],
  join: { table: deficiencies, alias: 'd', on: ['id', 'locationId'] },
  groupBy: { col: 'id' },
  aggregates: [
    {
      fn: 'count',
      arg: { alias: 'd', col: 'id' },
      distinct: true,
      as: 'count',
    },
  ],
});
// COUNT(DISTINCT "d"."id") AS "count" ... GROUP BY "locations"."id"
```

A join can exist **purely to feed an aggregate**: omit its `select.columns` and it projects nothing (so it needn't appear in `GROUP BY`), contributing no nested key to the result row.

```ts
// One row per user with a comma-joined list of their role names
const usersWithRoles = await users.select({
  columns: ['id', 'email'],
  join: { table: roles, type: 'left', alias: 'r', on: ['id', 'userId'] }, // no columns → not projected
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

PostgreSQL returns `COUNT` / `SUM` / `AVG` as bigint/numeric strings at the driver layer; Altacore coerces those aggregate outputs to `number`, mirroring `count()`.

> `count()` returns a scalar `COUNT(*)` and does not count grouped rows — wrap the grouped query if you need the number of groups. Ordered and `DISTINCT` string aggregation aren't modeled yet.

### Keyset (cursor) pagination

`keyset` paginates by a stable sort key instead of `offset` — the right tool for deep, consistent pagination and "load more" cursors. It is **mutually exclusive with `limit` / `offset`** (it carries its own `limit`).

```ts
// First page
const page1 = await users.select({
  columns: ['id', 'email', 'age'],
  keyset: {
    keys: [
      { expr: { col: 'age' }, direction: 'asc' },
      { expr: { col: 'id' }, direction: 'asc' }, // tiebreaker
    ],
    after: [0, 0], // start of the sequence
    limit: 25,
  },
});

// Next page: pass the last row's key values as `after`
const last = page1[page1.length - 1]!;
const page2 = await users.select({
  columns: ['id', 'email', 'age'],
  keyset: {
    keys: [
      { expr: { col: 'age' }, direction: 'asc' },
      { expr: { col: 'id' }, direction: 'asc' },
    ],
    after: [last.age, last.id],
    limit: 25,
  },
});
```

The seek predicate is emitted in expanded lexicographic form — portable across all three dialects (MSSQL has no row-value comparison):

```sql
WHERE ("age" > $1 OR ("age" = $2 AND "id" > $3))
ORDER BY "age" ASC, "id" ASC
LIMIT 25
```

The same `keys` drive both the predicate and the `ORDER BY`, so the two can never disagree. Keys may **span the outer table and joined aliases** (a cross-table cursor) and use `COALESCE` for nullable columns:

```ts
await certificates.select({
  columns: ['id'],
  join: {
    table: locations,
    alias: 'l',
    on: ['locationId', 'id'],
    select: { columns: ['customerNumber'] },
  },
  keyset: {
    keys: [
      { expr: { alias: 'l', col: 'customerNumber' }, direction: 'asc' },
      {
        expr: { coalesce: [{ col: 'expiresOn' }, '9999-12-31'] },
        direction: 'asc',
      },
      { expr: { col: 'id' }, direction: 'asc' }, // tiebreaker
    ],
    after: ['C-100', '2026-01-01', 0],
    limit: 50,
  },
});
```

Unlike offset pagination over joins (which subquery-wraps the outer table), a keyset query pages the **joined result set directly** — it's designed for cursoring through ordered result rows.

### Where clause operators

Each field accepts a bare value (equality) or an operator object. Operators on one field AND together; fields AND together at the top level.

| Operator                 | SQL                  | Notes                                      |
| ------------------------ | -------------------- | ------------------------------------------ |
| `eq`                     | `=`                  | `eq: null` → `IS NULL`                     |
| `ne`                     | `<>`                 | `ne: null` → `IS NOT NULL`                 |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` |                                            |
| `in`                     | `IN (...)`           | empty array → always-false (`1 = 0`)       |
| `nin`                    | `NOT IN (...)`       | empty array → always-true (`1 = 1`)        |
| `like`                   | `LIKE`               | string columns only (typed away on others) |

A bare `null` (`{ bio: null }`) translates to `IS NULL`. `not` is not yet supported.

### Combining conditions with `and` / `or`

`where` accepts two reserved group keys, `and` and `or`, each taking an array of nested `Where<T>` objects. Group keys sit alongside column conditions; sibling column conditions still AND together, and groups can nest arbitrarily.

```ts
// "active" = $1 AND ("name" LIKE $2 OR "age" > $3)
await users.select({
  where: {
    active: true,
    or: [{ email: { like: '%@example.com' } }, { age: { gt: 65 } }],
  },
});

// Nested: "active" = $1 AND ("email" LIKE $2 OR ("age" > $3 AND "bio" IS NOT NULL))
await users.select({
  where: {
    active: true,
    or: [
      { email: { like: '%@example.com' } },
      { and: [{ age: { gt: 65 } }, { bio: { ne: null } }] },
    ],
  },
});
```

Empty groups (`or: []`, `and: []`) and empty branches are skipped, so you can build them conditionally without guarding for the empty case. `and`, `or`, `exists`, and `notExists` are all reserved keys in `where`, so columns literally named that way can't be filtered through the property syntax — wrap them in a group instead.

### `EXISTS` / `NOT EXISTS` subqueries

`where` accepts two more reserved keys, `exists` and `notExists`, each taking one spec or an array. A spec is `{ table, on, where? }`: `on` correlates outer column(s) with the subquery's (`[outerCol, subCol]`, or an array of pairs for multi-column), and `where` adds further filters scoped to the subquery. This is how you filter the outer set against a related table without joining it.

```ts
// Active users who have at least one paid order
await users.select({
  where: {
    active: true,
    exists: {
      table: orders,
      on: ['id', 'userId'], // users.id = orders.userId
      where: { status: 'paid' },
    },
  },
});
```

```sql
SELECT * FROM "users"
WHERE "active" = $1
  AND EXISTS (
    SELECT 1 FROM "orders" AS "_ex0"
    WHERE "_ex0"."userId" = "users"."id" AND "_ex0"."status" = $2
  )
```

`notExists` emits `NOT EXISTS` (e.g. "users with no orders"). Pass an array to require several, and EXISTS works inside `and` / `or` groups too. Each subquery gets a unique `_exN` alias, so multiple (and nested) subqueries never collide.

### Ordering

`orderBy` accepts a single [column reference](#column-references-and-expressions) (or expression) or an array. `direction` defaults to `'asc'`.

```ts
// Single column
orderBy: { col: 'age', direction: 'desc' }

// Multiple columns (applied left to right)
orderBy: [
  { col: 'age', direction: 'desc' },
  { col: 'name' }, // direction omitted -> ASC
]

// Reference a joined alias, or order by a COALESCE expression
orderBy: [
  { alias: 'o', col: 'total', direction: 'desc' },
  { coalesce: [{ col: 'bio' }, ''], direction: 'asc' },
]
```

For cursor-style pagination, prefer [keyset pagination](#keyset-cursor-pagination), which derives a matching `ORDER BY` from the same keys.

When you `orderBy` on MSSQL with `limit`/`offset`, your ordering is used directly. Without `orderBy`, MSSQL still requires _some_ ordering for `OFFSET/FETCH` — Altacore inserts a synthetic `ORDER BY (SELECT NULL)`, which means rows come back in whatever order the engine chose. If you care about pagination stability, supply an explicit `orderBy`.

### Per-driver return shapes

- `select(...)` returns `T[]` (or `Pick<T, K>[]` with column projection) on every driver. With `join`, rows include a `{ [alias]: <projected joined row> }` slot per join, `| undefined` for LEFT/FULL no-matches. With `limit`/`offset` + `join`, the outer table is subquery-wrapped so pagination applies to outer rows.
- `selectWithCount(...)` returns `{ rows, total }` on every driver — `rows` is whatever `select(...)` would return for the same options; `total` is `count(...)` over the same `where` + `join` with `limit`/`offset` dropped.
- `count(...)` returns `number` on every driver. `join` is accepted and counts the joined result rows.
- `insert(values: Partial<T>)` returns `T`:
  - **pg** uses `RETURNING *` — the row reflects DB-applied defaults, autogen IDs, and trigger-modified values.
  - **mssql** uses `OUTPUT INSERTED.*` — same.
  - **mysql** has no native equivalent; the input is echoed back as-is. Fields you didn't supply will be absent from the returned object — select if you need a full row.
- `update(...)` returns `T[]`:
  - **pg** uses `RETURNING *` — post-update rows.
  - **mssql** uses `OUTPUT INSERTED.*` — same.
  - **mysql** returns `[]`. If you need the rows back, query separately.
- `delete(...)` returns the affected row count (`number`) on every driver.

### Safety guards

- `update` and `delete` require a non-empty `where` clause. Calling either with `where: {}` throws — refusing to update or delete every row in the table.
- `insert` requires at least one column with a defined value.

### Null values in returned rows

Altacore replaces SQL `NULL` with JavaScript `undefined` in returned rows. Model nullable columns with `?:` instead of `| null`:

```ts
type User = {
  id: number;
  email: string;
  bio?: string; // nullable column — preferred
  // bio: string | null;  // also valid, but you'll handle null at every read
};
```

The replacement is shallow — JSON column values keep their internal nulls intact.

## Database configuration

`createDatabase` is synchronous; the connection is established lazily on the first query.

```ts
const db = createDatabase({
  driver: 'pg', // 'pg' | 'mysql' | 'mssql'
  connectionString: process.env.DATABASE_URL!,
  pool: {
    max: 20,
    min: 2,
    idleTimeoutMillis: 30_000,
  },
});
```

### Pool config

`pool` is an optional, dialect-neutral subset of pool sizing knobs forwarded to the underlying driver:

| Field               | pg                  | mysql                                  | mssql                    |
| ------------------- | ------------------- | -------------------------------------- | ------------------------ |
| `max`               | `max`               | `connectionLimit`                      | `pool.max`               |
| `min`               | `min`               | _ignored — mysql2 has no minimum-idle_ | `pool.min`               |
| `idleTimeoutMillis` | `idleTimeoutMillis` | `idleTimeout`                          | `pool.idleTimeoutMillis` |

Anything outside this set should be configured by constructing the underlying driver directly — Altacore deliberately keeps this surface small.

## Raw queries (escape hatch)

If you need to drop down to raw SQL, the driver is exposed at `db.driver`:

```ts
const result = await db.driver.query<{ id: number; name: string }>(
  'SELECT id, name FROM users WHERE active = $1',
  [true],
);

console.log(result.rows); // { id, name }[]
console.log(result.rowCount); // number

await db.driver.close();
```

Placeholders are dialect-specific: `@p1` for MSSQL, `?` for MySQL, `$1` for PostgreSQL. The dialect helpers are also exposed at `db.driver.dialect`:

```ts
db.driver.dialect.placeholder(1); // '@p1' on mssql
db.driver.dialect.quoteIdentifier('users'); // '[users]' on mssql
```

## Development

```bash
npm install
npm run build       # tsup -> dist/ (esm + cjs + .d.ts)
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run format      # prettier --write
```

## License

[Apache 2.0](LICENSE)

Copyright 2026 Jesse Brower. See [NOTICE](NOTICE) for attribution requirements.
