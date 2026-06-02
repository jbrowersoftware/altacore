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

function buildInternal<T>(
  where: Where<T> | undefined,
  dialect: SqlDialect,
  offset: number,
  qualifier: string | undefined,
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
        const value = condition[k];
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
): WhereSql {
  const r = buildInternal(where, dialect, offset, qualifier);
  return { sql: r.sql, params: r.params };
}
