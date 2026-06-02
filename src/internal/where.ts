import type { Where } from '../core/dbCore.js';

export type SqlDialect = {
  // Render the placeholder for a 1-based parameter index.
  // pg: i => `$${i}`, mysql: () => '?', mssql: i => `@p${i}`
  placeholder: (oneBasedIndex: number) => string;
  // Quote a column/table identifier safely for the target dialect.
  quoteIdentifier: (name: string) => string;
  // Render the LIMIT/OFFSET clause for SELECT. Result includes a leading
  // space when non-empty so callers can append directly. mssql diverges:
  // OFFSET/FETCH requires ORDER BY — when `hasOrderBy` is false a synthetic
  // ORDER BY is emitted; when true, the caller is trusted to have already
  // emitted one.
  formatLimitOffset: (
    limit?: number,
    offset?: number,
    hasOrderBy?: boolean,
  ) => string;
  // How (and whether) the dialect returns affected rows from INSERT/UPDATE.
  //   'returning' — pg-style `RETURNING *` suffix
  //   'output'    — mssql-style `OUTPUT INSERTED.*` mid-statement
  //   'none'      — not natively supported (mysql)
  returningStrategy: 'returning' | 'output' | 'none';
  // String aggregation. `expr` is the already-rendered column expression and
  // `separator` the already-rendered separator placeholder. pg/mssql use
  // STRING_AGG; mysql uses GROUP_CONCAT(... SEPARATOR ...). Returns the full
  // function call without the trailing `AS <alias>`.
  stringAgg: (expr: string, separator: string) => string;
};

export type WhereSql = {
  sql: string;
  params: unknown[];
};

const OPERATOR_KEYS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'nin',
  'like',
] as const;

type OperatorKey = (typeof OPERATOR_KEYS)[number];
const OPERATOR_SET: ReadonlySet<string> = new Set(OPERATOR_KEYS);

const BINARY_SQL: Record<Exclude<OperatorKey, 'in' | 'nin'>, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
};

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Buffer)
  );
}

type BuildOutput = WhereSql & { partCount: number };

// Mutable counter so every EXISTS subquery (including nested ones across the
// whole where tree) gets a unique `_exN` alias.
type ExistsCtx = { n: number };

function buildInternal<T>(
  where: Where<T> | undefined,
  dialect: SqlDialect,
  offset: number,
  qualifier: string | undefined,
  // Outer table/alias used to qualify the outer side of EXISTS correlation
  // predicates. In single-table queries `qualifier` is undefined (columns stay
  // unqualified) but correlation still needs the outer table name to
  // disambiguate from the subquery alias.
  outerTable: string | undefined,
  existsCtx: ExistsCtx,
): BuildOutput {
  if (!where) return { sql: '', params: [], partCount: 0 };

  const parts: string[] = [];
  const params: unknown[] = [];

  const addParam = (value: unknown): string => {
    params.push(value);
    return dialect.placeholder(offset + params.length);
  };

  const prefix = qualifier ? `${dialect.quoteIdentifier(qualifier)}.` : '';

  for (const [column, condition] of Object.entries(where)) {
    if (condition === undefined) continue;

    if (column === 'and' || column === 'or') {
      if (!Array.isArray(condition)) {
        throw new TypeError(
          `altacore: "${column}" expects an array of where conditions.`,
        );
      }
      const branchSqls: string[] = [];
      for (const branch of condition as readonly Where<T>[]) {
        const sub = buildInternal(
          branch,
          dialect,
          offset + params.length,
          qualifier,
          outerTable,
          existsCtx,
        );
        if (!sub.sql) continue;
        params.push(...sub.params);
        // A branch that is itself a multi-part AND must be parenthesized
        // before being joined under a different operator.
        branchSqls.push(sub.partCount > 1 ? `(${sub.sql})` : sub.sql);
      }
      if (branchSqls.length === 0) continue;
      const joiner = column === 'and' ? ' AND ' : ' OR ';
      const combined =
        branchSqls.length === 1 ? branchSqls[0]! : branchSqls.join(joiner);
      parts.push(branchSqls.length > 1 ? `(${combined})` : combined);
      continue;
    }

    if (column === 'exists' || column === 'notExists') {
      const specs = Array.isArray(condition) ? condition : [condition];
      for (const spec of specs as readonly ExistsSpecRuntime[]) {
        const r = buildExists(
          spec,
          column === 'notExists',
          dialect,
          outerTable ?? qualifier,
          offset + params.length,
          existsCtx,
        );
        params.push(...r.params);
        parts.push(r.sql);
      }
      continue;
    }

    const col = `${prefix}${dialect.quoteIdentifier(column)}`;

    if (isOperatorObject(condition)) {
      const keys = Object.keys(condition);
      if (keys.length === 0) continue;

      for (const k of keys) {
        if (!OPERATOR_SET.has(k)) {
          throw new TypeError(
            `altacore: unknown operator "${k}" on column "${column}". ` +
              `Valid operators: ${OPERATOR_KEYS.join(', ')}.`,
          );
        }
      }

      for (const k of keys) {
        const op = k as OperatorKey;
        const value = (condition as Record<string, unknown>)[k];
        if (value === undefined) continue;

        if (op === 'in' || op === 'nin') {
          if (!Array.isArray(value)) {
            throw new TypeError(
              `altacore: operator "${op}" expects an array (column "${column}").`,
            );
          }
          if (value.length === 0) {
            // SQL forbids `IN ()`. Preserve correct boolean semantics for an empty list.
            parts.push(op === 'in' ? '1 = 0' : '1 = 1');
            continue;
          }
          const placeholders = (value as unknown[])
            .map((v) => addParam(v))
            .join(', ');
          parts.push(
            `${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${placeholders})`,
          );
          continue;
        }

        if ((op === 'eq' || op === 'ne') && value === null) {
          parts.push(`${col} IS ${op === 'eq' ? '' : 'NOT '}NULL`);
          continue;
        }

        parts.push(`${col} ${BINARY_SQL[op]} ${addParam(value)}`);
      }
      continue;
    }

    if (condition === null) {
      parts.push(`${col} IS NULL`);
    } else {
      parts.push(`${col} = ${addParam(condition)}`);
    }
  }

  return { sql: parts.join(' AND '), params, partCount: parts.length };
}

export function buildWhere<T>(
  where: Where<T> | undefined,
  dialect: SqlDialect,
  // Offset for placeholder numbering — lets a WHERE clause be appended after
  // an existing parameter list (e.g. UPDATE's SET clause, or after a JOIN's
  // ON-AND predicates).
  offset = 0,
  // Optional table/alias name to prefix every column reference with. Used
  // by the join builder so outer-table refs become `"users"."col"` and
  // joined-table refs become `"<alias>"."col"`. When omitted, column refs
  // are emitted unqualified (existing single-table behavior).
  qualifier?: string,
  // Outer table name for EXISTS correlation. Defaults to `qualifier`; pass it
  // explicitly on the single-table path (where `qualifier` is undefined but
  // correlation still needs the outer table to disambiguate the subquery).
  outerTable?: string,
): WhereSql {
  const r = buildInternal(where, dialect, offset, qualifier, outerTable, {
    n: 0,
  });
  return { sql: r.sql, params: r.params };
}

// -----------------------------------------------------------------------------
// EXISTS / NOT EXISTS correlated subqueries
// -----------------------------------------------------------------------------
type ExistsCorrPair = readonly [string, string]; // [outerCol, subCol]
type ExistsSpecRuntime = {
  table: { tableName: string };
  on: ExistsCorrPair | readonly ExistsCorrPair[];
  where?: Where<unknown>;
};

function normalizeExistsOn(
  on: ExistsSpecRuntime['on'],
): readonly ExistsCorrPair[] {
  if (on.length === 0) {
    throw new TypeError(`altacore: exists 'on' cannot be empty.`);
  }
  return Array.isArray(on[0])
    ? (on as readonly ExistsCorrPair[])
    : [on as ExistsCorrPair];
}

function buildExists(
  spec: ExistsSpecRuntime,
  negate: boolean,
  dialect: SqlDialect,
  outerQualifier: string | undefined,
  offset: number,
  existsCtx: ExistsCtx,
): WhereSql {
  const subAlias = `_ex${existsCtx.n++}`;
  const subAliasQ = dialect.quoteIdentifier(subAlias);
  const subTableQ = dialect.quoteIdentifier(spec.table.tableName);
  const outerPrefix = outerQualifier
    ? `${dialect.quoteIdentifier(outerQualifier)}.`
    : '';

  // Correlation predicates compare columns — they bind no params.
  const conds = normalizeExistsOn(spec.on).map(([outerCol, subCol]) => {
    const outerRef = `${outerPrefix}${dialect.quoteIdentifier(outerCol)}`;
    const subRef = `${subAliasQ}.${dialect.quoteIdentifier(subCol)}`;
    return `${subRef} = ${outerRef}`;
  });

  // Extra sub-filters are scoped to the sub alias; their params continue from
  // the current offset (correlation added none). Share existsCtx so nested
  // EXISTS keep unique aliases.
  const sub = buildInternal(
    spec.where,
    dialect,
    offset,
    subAlias,
    subAlias,
    existsCtx,
  );
  if (sub.sql) conds.push(sub.sql);

  const inner = `SELECT 1 FROM ${subTableQ} AS ${subAliasQ} WHERE ${conds.join(
    ' AND ',
  )}`;
  return {
    sql: `${negate ? 'NOT ' : ''}EXISTS (${inner})`,
    params: sub.params,
  };
}

// -----------------------------------------------------------------------------
// Column references & expressions (shared by orderBy, groupBy, keyset, aggregates)
// -----------------------------------------------------------------------------
// Runtime shapes — the typed public surface (ColRef/Expr in dbCore.ts) narrows
// these to the columns actually available; here we only need to read `col`,
// the optional `alias`, and the `coalesce` tuple structurally.

// A bare `{ col }` ref resolves against `outerQualifier`; a `{ alias, col }`
// ref ignores it and qualifies by its own alias (joins are always aliased).
export type RefRuntime = { col: string; alias?: string };
export type ExprRuntime =
  | RefRuntime
  | { coalesce: readonly [RefRuntime, unknown] };

export function renderRef(
  ref: RefRuntime,
  dialect: SqlDialect,
  outerQualifier?: string,
): string {
  const q = ref.alias ?? outerQualifier;
  const prefix = q ? `${dialect.quoteIdentifier(q)}.` : '';
  return `${prefix}${dialect.quoteIdentifier(ref.col)}`;
}

function isCoalesce(
  expr: ExprRuntime,
): expr is { coalesce: readonly [RefRuntime, unknown] } {
  return typeof expr === 'object' && expr !== null && 'coalesce' in expr;
}

// Render an expression to SQL, pushing any bound params onto `params`.
// Placeholder numbering continues from `offset + params.length` so an
// expression can be appended after an existing parameter list (WHERE, ON, …).
// COALESCE is standard SQL across pg/mysql/mssql, so no per-dialect branch.
export function renderExpr(
  expr: ExprRuntime,
  dialect: SqlDialect,
  outerQualifier: string | undefined,
  params: unknown[],
  offset: number,
): string {
  if (isCoalesce(expr)) {
    const [ref, fallback] = expr.coalesce;
    params.push(fallback);
    const ph = dialect.placeholder(offset + params.length);
    return `COALESCE(${renderRef(ref, dialect, outerQualifier)}, ${ph})`;
  }
  return renderRef(expr, dialect, outerQualifier);
}
