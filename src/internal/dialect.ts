import type { SqlDialect } from './where.js';
import type { DatabaseDriver } from '../core/database.js';

function ensureValidIdentifier(name: string, dialect: string): void {
  if (name.length === 0) {
    throw new TypeError(`altacore: empty identifier (dialect: ${dialect}).`);
  }
  if (name.includes('\0')) {
    throw new TypeError(
      `altacore: identifier contains a null byte (dialect: ${dialect}).`,
    );
  }
}

const standardLimitOffset = (limit?: number, offset?: number): string => {
  let sql = '';
  if (limit !== undefined) sql += ` LIMIT ${limit}`;
  if (offset !== undefined) sql += ` OFFSET ${offset}`;
  return sql;
};

const mssqlLimitOffset = (
  limit?: number,
  offset?: number,
  hasOrderBy = false,
): string => {
  if (limit === undefined && offset === undefined) return '';
  const off = offset ?? 0;
  // MSSQL OFFSET/FETCH requires ORDER BY. If the caller already emitted one,
  // skip the synthetic; otherwise insert (SELECT NULL) as a no-op ordering.
  const orderPrefix = hasOrderBy ? '' : ' ORDER BY (SELECT NULL)';
  let sql = `${orderPrefix} OFFSET ${off} ROWS`;
  if (limit !== undefined) sql += ` FETCH NEXT ${limit} ROWS ONLY`;
  return sql;
};

export const pgDialect: SqlDialect = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'pg');
    return `"${name.replaceAll('"', '""')}"`;
  },
  formatLimitOffset: standardLimitOffset,
  returningStrategy: 'returning',
  stringAgg: (expr, separator) => `STRING_AGG(${expr}, ${separator})`,
};

export const mysqlDialect: SqlDialect = {
  placeholder: () => '?',
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'mysql');
    return '`' + name.replaceAll('`', '``') + '`';
  },
  formatLimitOffset: standardLimitOffset,
  returningStrategy: 'none',
  stringAgg: (expr, separator) =>
    `GROUP_CONCAT(${expr} SEPARATOR ${separator})`,
};

export const mssqlDialect: SqlDialect = {
  placeholder: (index) => `@p${index}`,
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'mssql');
    return `[${name.replaceAll(']', ']]')}]`;
  },
  formatLimitOffset: mssqlLimitOffset,
  returningStrategy: 'output',
  stringAgg: (expr, separator) => `STRING_AGG(${expr}, ${separator})`,
};

export const DIALECTS: Record<DatabaseDriver, SqlDialect> = {
  pg: pgDialect,
  mysql: mysqlDialect,
  mssql: mssqlDialect,
};
