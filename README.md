# Altacore

A lightweight, easy-to-use ORM framework for Node.js applications working with **Microsoft SQL Server**, **MySQL**, and **PostgreSQL**.

> **Status:** pre-1.0, under active development. The public API is not yet stable.

## Why Altacore

Altacore aims for the middle ground between hand-rolled query builders and heavyweight, opinionated ORMs — a small functional API that gives you typed queries and connection management without the abstraction cost.

- **Lightweight** — minimal runtime, no decorators, no metadata reflection
- **Functional** — factory functions and plain data, not classes or inheritance
- **Multi-database** — one API across SQL Server, MySQL, and PostgreSQL
- **TypeScript-first** — full type definitions, ESM and CJS shipped side by side

## Supported databases

| Database | Driver (peer dependency) |
| --- | --- |
| Microsoft SQL Server | [`mssql`](https://www.npmjs.com/package/mssql) |
| MySQL | [`mysql2`](https://www.npmjs.com/package/mysql2) |
| PostgreSQL | [`pg`](https://www.npmjs.com/package/pg) |

You install the driver for the database you actually use — Altacore does not bundle them.

## Requirements

- Node.js 20 or later

## Installation

```bash
npm install altacore
```

Plus the driver for your database:

```bash
npm install pg          # PostgreSQL
npm install mysql2      # MySQL
npm install mssql       # Microsoft SQL Server
```

## Quick start

> The snippet below sketches the intended API shape. Specific signatures may change before 1.0.

```ts
import { createDatabase } from 'altacore';

const db = createDatabase({
  driver: 'pg',
  connectionString: process.env.DATABASE_URL,
});

const users = await db.query('SELECT * FROM users WHERE active = $1', [true]);
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
