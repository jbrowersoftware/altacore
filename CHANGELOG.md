# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-05-13

### Added

- Typed `join` option on `select()` and `count()`. A `JoinSpec` carries `table`, `type` (`'inner'` (default) | `'left'` | `'right'` | `'full'`), `alias`, `on` (single tuple or array of tuples for multi-column ON), and a nested `select` describing the joined-table projection, filters, and further nested joins. `join` accepts either one `JoinSpec` or an array.
- Result rows are nested by alias: each join contributes `{ [alias]: <projected joined row> }`. LEFT/FULL joins with no match leave the slot as `undefined` (detected by all-joined-columns-undefined).
- Const-typed generic overloads on `SelectFn<T>` preserve literal `alias` / `type` / `select.columns` inference end-to-end, so consumers get exact nested return types without `as const`.
- `where` inside a join's `select` is AND-ed into the SQL `ON` clause (not the outer `WHERE`), preserving LEFT/FULL semantics. The README's "Joining tables" section documents the trap this avoids.
- `DbCore<T>` now exposes `readonly tableName: string` (the SQL identifier passed at creation) so joins can reach through the `JoinSpec.table` reference; also useful for introspection.
- New public type exports: `JoinType`, `OnPair`, `OnSpec`, `JoinSelect`, `JoinSpec`, `AnyJoin`.

### Changed

- `buildWhere` accepts an optional `qualifier` parameter that prefixes column refs with `"<table>"."<col>"`. No behavior change for single-table callers.

## [0.0.2] - 2026-05-13

### Added

- `count(options?)` method on `DbCore<T>` returns the matching row count as a `number`. Accepts the same `where` syntax as `select`; omit `where` to count every row. PostgreSQL's bigint-string result is coerced so consumers always get a `number`.
- `CountOptions<T>` type exported from the public surface.

## [0.0.1] - 2026-05-11

### Added

- Initial release.
- Typed CRUD core via `createDbCore`: `select` (with column projection narrowing to `Pick<T, K>[]`), `insert`, `update`, `delete`.
- Typed `where` builder with `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`; `null` handling translates to `IS NULL` / `IS NOT NULL`; `and` / `or` group composition with arbitrary nesting.
- `orderBy` accepting a single column or an array (asc/desc).
- Drivers for PostgreSQL (`pg`), MySQL (`mysql2`), and Microsoft SQL Server (`mssql`), wired as optional peer dependencies.
- Row-returning `insert` / `update` via `RETURNING *` (pg) and `OUTPUT INSERTED.*` (mssql); mysql echoes input on insert and returns `[]` on update.
- Safety guards: `update` and `delete` refuse an empty `where`; `insert` requires at least one defined column.
- Connection pool config passthrough (`max`, `min`, `idleTimeoutMillis`).
- ESM + CJS dual package shipped via tsup, with `.d.ts` types for both.
