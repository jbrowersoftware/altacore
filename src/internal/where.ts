import type { Where } from '../core/dbCore.js';

export type SqlDialect = {
  // Render the placeholder for a 1-based parameter index.
  // pg: i => `$${i}`, mysql: () => '?', mssql: i => `@p${i}`
  placeholder: (oneBasedIndex: number) => string;
  // Quote a column/table identifier safely for the target dialect.
  quoteIdentifier: (name: string) => string;
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

export function buildWhere<T>(
  where: Where<T> | undefined,
  dialect: SqlDialect,
): WhereSql {
  if (!where) return { sql: '', params: [] };

  const parts: string[] = [];
  const params: unknown[] = [];

  const addParam = (value: unknown): string => {
    params.push(value);
    return dialect.placeholder(params.length);
  };

  for (const [column, condition] of Object.entries(where)) {
    if (condition === undefined) continue;

    const col = dialect.quoteIdentifier(column);

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

  return { sql: parts.join(' AND '), params };
}
