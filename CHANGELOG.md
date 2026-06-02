# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-06-02

### Fixed

- **Offset pagination over a join no longer emits an unbound joined-alias reference in the inner pagination subquery's `ORDER BY`.** When `select({ join, limit/offset, orderBy })` ordered by a joined column (`{ alias, col }`, or a `COALESCE` over one), that ref was passed verbatim into the outer-table-only subquery, producing e.g. `ORDER BY "l"."CustomerNumber"` where the alias was unbound — SQL Server raised "the multi-part identifier could not be bound." Alias-qualified `orderBy` entries are now dropped from the inner subquery (they still apply on the outer wrapper, where the join exists); MSSQL falls back to its synthetic `ORDER BY (SELECT NULL)` when no outer-column key remains. For pagination whose primary sort is a joined column, use keyset pagination.

## [0.1.0] - 2026-06-02

### Breaking changes

- **`SelectFn<T>` / `SelectWithCountFn<T>` overloads gained a generic alias-map (`M`) and an aggregates type parameter (`A`).** Every existing call pattern resolves to the same overload and return type. Only impact: code that declares a variable typed as `SelectFn<T>` / `SelectWithCountFn<T>` and assigns a function not handling the widened generics may fail to type-check.
- **`SqlDialect` gains a required `stringAgg(expr, separator)` method.** Consumers who construct a custom `SqlDialect` (the three built-in dialects are unaffected) must add it.

### Added

- **Qualified column references in `orderBy` and `groupBy`.** A ref is either `{ col }` (outer table) or `{ alias, col }` (any joined alias on the same call). The alias map is derived from the call's joins, so refs are type-checked against the real joined tables — and may target any column of a joined table, even one that isn't projected.
- **`groupBy`** option — one expression or an array; refs may span the outer table and joined aliases.
- **Keyset / cursor pagination** via `keyset: { keys, after, limit? }`. Emits the expanded lexicographic seek predicate (`(k0 > ?) OR (k0 = ? AND k1 > ?) …`, portable across all three dialects — no row-value comparison) and a matching `ORDER BY` from the same keys. Keys may span the outer table and joined aliases and use `COALESCE` for nullable columns. Pages the joined result set directly (flat emission); mutually exclusive with `limit`/`offset`.
- **`COALESCE` expression** (`{ coalesce: [ref, fallback] }`) usable anywhere an `Expr` is accepted (orderBy, groupBy, keyset keys, aggregate args) — portable nullable-column ordering/cursoring.
- **Aggregate output columns** via `aggregates: Aggregate[]`: `count` (with `'*'` or a column, optional `distinct`), `sum`/`avg`/`min`/`max`, and `stringAgg` (STRING_AGG on pg/mssql, GROUP_CONCAT on mysql). Each `as` becomes a typed result-row key (count/sum/avg → `number`, stringAgg → `string`, min/max → the column type for a plain outer-column arg). Numeric outputs are coerced from pg's bigint/numeric strings, mirroring `count()`.
- **`EXISTS` / `NOT EXISTS`** correlated subqueries in `where` via the reserved `exists` / `notExists` keys: `{ table, on, where? }`. `on` correlates outer column(s) with the subquery's; `where` adds alias-scoped sub-filters. Each subquery gets a unique `_exN` alias; nested EXISTS are supported.
- A join used purely to feed an aggregate (e.g. STRING_AGG over a joined column) may omit `select.columns` — it then projects nothing and need not appear in `GROUP BY`. Its alias contributes no result-row key.
- New public type exports: `ColRef`, `Expr`, `Keyset`, `KeysetKey`, `Aggregate`, `ExistsSpec`.

### Known limitations

- Ordered / `DISTINCT` string aggregation is not yet modeled (plain `STRING_AGG(expr, sep)` / `GROUP_CONCAT(expr SEPARATOR sep)` only).
- `count()` returns a scalar `COUNT(*)`; it does not count grouped rows. Use a wrapping query if you need group counts.

## [0.0.3] - 2026-05-13

### Breaking changes

- **`DbCore<T>` shape adds two required fields: `readonly tableName: string` and `selectWithCount: SelectWithCountFn<T>`.** Consumers who construct or mock `DbCore<T>` objects manually (test doubles, alternative implementations) must add both. Code that obtains `DbCore<T>` via `createDbCore()` is unaffected — the factory populates them automatically.
- **`SelectFn<T>` overload set expanded from 2 to 4** (added single-join and array-join overloads ahead of the existing column-projection and bare overloads). Every existing call pattern still resolves to the same overload and the same return type. Only impact: code that declares a variable typed as `SelectFn<T>` and assigns a function not handling the new overloads will fail to type-check.

### Added

- Typed `join` option on `select()` and `count()`. A `JoinSpec` carries `table`, `type` (`'inner'` (default) | `'left'` | `'right'` | `'full'`), `alias`, `on` (single tuple or array of tuples for multi-column ON), and a nested `select` describing the joined-table projection, filters, and further nested joins. `join` accepts either one `JoinSpec` or an array.
- Result rows are nested by alias: each join contributes `{ [alias]: <projected joined row> }`. LEFT/FULL joins with no match leave the slot as `undefined` (detected by all-joined-columns-undefined).
- Const-typed generic overloads on `SelectFn<T>` preserve literal `alias` / `type` / `select.columns` inference end-to-end, so consumers get exact nested return types without `as const`.
- `where` inside a join's `select` is AND-ed into the SQL `ON` clause (not the outer `WHERE`), preserving LEFT/FULL semantics. The README's "Joining tables" section documents the trap this avoids.
- Subquery-wrapped pagination for `select` with `join` + `limit`/`offset`: the outer table is paginated inside a derived `(SELECT ...) AS page` subquery, then joins are applied outside. `LIMIT 10` now means "10 outer rows," not "10 join-expanded result rows." The inner subquery drives the page; an outer `ORDER BY` keeps result rows in the same outer order after the join's row expansion.
- `selectWithCount(options?) → { rows, total }` on `DbCore<T>`. Runs `select` (with pagination if specified) and `count` (with `limit`/`offset` dropped) in parallel over the same `where` + `join`. Overloads mirror `select` end-to-end so column projection narrows `rows` and joins nest by alias.
- `DbCore<T>` now exposes `readonly tableName: string` (the SQL identifier passed at creation) so joins can reach through the `JoinSpec.table` reference; also useful for introspection.
- New public type exports: `JoinType`, `OnPair`, `OnSpec`, `JoinSelect`, `JoinSpec`, `AnyJoin`, `SelectFn`, `SelectWithCountFn`.

### Changed

- `buildWhere` accepts an optional `qualifier` parameter that prefixes column refs with `"<table>"."<col>"`. No behavior change for single-table callers.

### Known limitations

- **1:N joins still duplicate outer rows in the result.** The nested-by-alias result shape carries a single joined row per alias slot, so a 1:N join produces multiple result rows that share an outer row. Pagination correctly limits outer rows in the subquery, but `result.length` can exceed the page size when 1:N expands. `count()` (and `selectWithCount`'s `total`) counts join-result rows for the same reason. Array-shaped joined data is not modeled in v1.

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
