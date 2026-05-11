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

export const pgDialect: SqlDialect = {
  placeholder: (index) => `$${index}`,
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'pg');
    return `"${name.replaceAll('"', '""')}"`;
  },
};

export const mysqlDialect: SqlDialect = {
  placeholder: () => '?',
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'mysql');
    return '`' + name.replaceAll('`', '``') + '`';
  },
};

export const mssqlDialect: SqlDialect = {
  placeholder: (index) => `@p${index}`,
  quoteIdentifier: (name) => {
    ensureValidIdentifier(name, 'mssql');
    return `[${name.replaceAll(']', ']]')}]`;
  },
};

export const DIALECTS: Record<DatabaseDriver, SqlDialect> = {
  pg: pgDialect,
  mysql: mysqlDialect,
  mssql: mssqlDialect,
};
