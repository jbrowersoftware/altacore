# Altacore

A lightweight, easy-to-use ORM framework for Node.js applications working with **Microsoft SQL Server**, **MySQL**, and **PostgreSQL**.

> **Status:** pre-1.0, in active development. Working today: typed CRUD via `createDbCore` (select with column projection, insert, update, delete), the typed `where` builder, `orderBy`, all three drivers (MSSQL, MySQL, PostgreSQL), row-returning insert/update via `RETURNING` (pg) and `OUTPUT INSERTED.*` (mssql), and connection pool config passthrough.

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

The heart of Altacore is **`createDbCore`** — a typed CRUD core bound to one table. Define a row type once, then `select` / `insert` / `update` / `delete` with full type inference.

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

A bare `null` (`{ bio: null }`) translates to `IS NULL`. Top-level `or` / `not` / nested groups are not yet supported.

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

- `select(...)` returns `T[]` (or `Pick<T, K>[]` with column projection) on every driver.
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

| Field               | pg                  | mysql                                    | mssql                            |
| ------------------- | ------------------- | ---------------------------------------- | -------------------------------- |
| `max`               | `max`               | `connectionLimit`                        | `pool.max`                       |
| `min`               | `min`               | _ignored — mysql2 has no minimum-idle_   | `pool.min`                       |
| `idleTimeoutMillis` | `idleTimeoutMillis` | `idleTimeout`                            | `pool.idleTimeoutMillis`         |

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

[MIT](LICENSE)
