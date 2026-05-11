# Altacore

A lightweight, easy-to-use ORM framework for Node.js applications working with **Microsoft SQL Server**, **MySQL**, and **PostgreSQL**.

> **Status:** pre-1.0, in active development. Working today: `createDatabase`, raw queries via `db.driver.query`, the typed `where` builder, all three drivers (MSSQL, MySQL, PostgreSQL). In progress: `createDbCore` CRUD execution.

## Why Altacore

Altacore aims for the middle ground between hand-rolled query builders and heavyweight, opinionated ORMs — a small functional API that gives you typed queries and connection management without the abstraction cost.

- **Lightweight** — minimal runtime, no decorators, no metadata reflection
- **Functional** — factory functions and plain data, not classes or inheritance
- **Multi-database** — one API across SQL Server, MySQL, and PostgreSQL
- **TypeScript-first** — full type definitions, ESM and CJS shipped side by side

## Supported databases

| Database | Driver (peer dependency) | Status |
| --- | --- | --- |
| Microsoft SQL Server | [`mssql`](https://www.npmjs.com/package/mssql) | Wired |
| MySQL | [`mysql2`](https://www.npmjs.com/package/mysql2) | Wired |
| PostgreSQL | [`pg`](https://www.npmjs.com/package/pg) | Wired |

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

`createDatabase` is synchronous; the connection is established lazily on the first query.

```ts
import { createDatabase } from 'altacore';

const db = createDatabase({
  driver: 'mssql',
  connectionString: process.env.DATABASE_URL!,
});

const result = await db.driver.query<{ id: number; name: string }>(
  'SELECT id, name FROM users WHERE active = @p1',
  [true],
);

console.log(result.rows);     // { id, name }[]
console.log(result.rowCount); // number

await db.driver.close();
```

Placeholders are dialect-specific: `@p1` for MSSQL, `?` for MySQL, `$1` for PostgreSQL. The dialect is also exposed at `db.driver.dialect` if you're composing SQL by hand:

```ts
db.driver.dialect.placeholder(1);            // '@p1' on mssql
db.driver.dialect.quoteIdentifier('users');  // '[users]' on mssql
```

## Null values

Altacore replaces SQL `NULL` with JavaScript `undefined` in returned rows. Model nullable columns with `?:` instead of `| null`:

```ts
type User = {
  id: number;
  email: string;
  bio?: string;     // nullable column — preferred
  // bio: string | null;  // also valid, but you'll handle null at every read
};
```

The replacement is shallow — JSON column values keep their internal nulls intact.

## Typed repository (designed, execution coming)

`createDbCore<T>(db, table)` is the planned ergonomic surface — a typed CRUD core bound to one table:

```ts
import { createDbCore } from 'altacore';

type User = { id: number; email: string; active: boolean; age: number };
const users = createDbCore<User>(db, 'users');

await users.select({
  where: {
    active: true,                    // bare value = equality
    age: { gt: 18, lte: 65 },        // operators AND-ed per field
    email: { like: '%@example.com' },
  },
  limit: 10,
});

await users.insert({ id: 1, email: 'a@b.com', active: true, age: 30 });
await users.update({ where: { id: 1 }, set: { active: false } });
await users.delete({ where: { id: 1 } });
```

The types are in place today; the execution layer is not yet wired. Methods currently reject with `not yet implemented`.

## Where clause operators

Each field accepts a bare value (equality) or an operator object. Operators on one field AND together; fields AND together at the top level.

| Operator | SQL | Notes |
| --- | --- | --- |
| `eq` | `=` | `eq: null` → `IS NULL` |
| `ne` | `<>` | `ne: null` → `IS NOT NULL` |
| `gt`, `gte`, `lt`, `lte` | `>`, `>=`, `<`, `<=` | |
| `in` | `IN (...)` | empty array → always-false (`1 = 0`) |
| `nin` | `NOT IN (...)` | empty array → always-true (`1 = 1`) |
| `like` | `LIKE` | string columns only (typed away on others) |

Top-level `or` / `not` / nested groups are not yet supported.

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
