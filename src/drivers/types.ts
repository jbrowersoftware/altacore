import type { SqlDialect } from '../internal/where.js';
import type { DatabaseConfig, DatabaseDriver } from '../core/database.js';

export type QueryResult<R = unknown> = {
  rows: R[];
  // rows.length for SELECT; affected rows for INSERT/UPDATE/DELETE.
  rowCount: number;
};

export type Driver = {
  readonly kind: DatabaseDriver;
  readonly dialect: SqlDialect;
  query<R = unknown>(
    sql: string,
    params: readonly unknown[],
  ): Promise<QueryResult<R>>;
  // Idempotent.
  close(): Promise<void>;
};

export type DriverFactory = (config: DatabaseConfig) => Driver;
