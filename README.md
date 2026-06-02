# Altacore

A lightweight, easy-to-use ORM framework for Node.js applications working with **Microsoft SQL Server**, **MySQL**, and **PostgreSQL**.

> **Status:** pre-1.0, in active development. Working today: typed CRUD via `createDbCore` (select with column projection, count, insert, update, delete), typed joins (inner / left / right / full, multi-column ON, nested joins, array of joins, count over a join) with nested-by-alias result rows, the typed `where` builder, `orderBy`, all three drivers (MSSQL, MySQL, PostgreSQL), row-returning insert/update via `RETURNING` (pg) and `OUTPUT INSERTED.*` (mssql), and connection pool config passthrough.

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
  { id: 2, name: 'Bob',   o: { id: 12, total: 200 } },
  { id: 3, name: 'Carol', o: undefined },
]
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

- **`select.columns` is required on every join used with `select()`.** The SQL builder needs the column list to emit alias-qualified projections (`"o"."id" AS "o.id"`) so the result mapper can nest rows by dotted key. Omitting it throws a clear runtime error. `count()` skips this requirement since it doesn't project.
- **Outer `where` columns can't reference joined columns yet.** If you need to filter the result set against a joined column, either switch the join to `inner` (if dropping unmatched outer rows is the goal) or wait for a future dotted-key / `having` mechanism.
- **`orderBy` is outer-only.** Ordering by a joined column isn't expressible in v1.
- **Don't use column names containing `.`** when joining — the result mapper splits keys on dots to nest. Source columns with literal dots in their names will be misinterpreted.

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

Empty groups (`or: []`, `and: []`) and empty branches are skipped, so you can build them conditionally without guarding for the empty case. Because `and` and `or` are reserved group keys, columns literally named `and` or `or` can't be filtered through the property syntax — wrap them in a group instead.

### Ordering

`orderBy` accepts a single column or an array. `direction` defaults to `'asc'`.

```ts
// Single column
orderBy: { col: 'age', direction: 'desc' }

// Multiple columns (applied left to right)
orderBy: [
  { col: 'age', direction: 'desc' },
  { col: 'name' }, // direction omitted -> ASC
]
```

When you `orderBy` on MSSQL with `limit`/`offset`, your ordering is used directly. Without `orderBy`, MSSQL still requires _some_ ordering for `OFFSET/FETCH` — Altacore inserts a synthetic `ORDER BY (SELECT NULL)`, which means rows come back in whatever order the engine chose. If you care about pagination stability, supply an explicit `orderBy`.

### Per-driver return shapes

- `select(...)` returns `T[]` (or `Pick<T, K>[]` with column projection) on every driver. With `join`, rows include a `{ [alias]: <projected joined row> }` slot per join, `| undefined` for LEFT/FULL no-matches.
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
