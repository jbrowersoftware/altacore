import { Pool } from 'pg';

import type { DatabaseConfig } from '../core/database.js';
import { pgDialect } from '../internal/dialect.js';
import type { Driver, DriverFactory, QueryResult } from './types.js';

export const createPgDriver: DriverFactory = (
  config: DatabaseConfig,
): Driver => {
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.pool?.max,
    min: config.pool?.min,
    idleTimeoutMillis: config.pool?.idleTimeoutMillis,
  });

  let closed = false;

  return {
    kind: 'pg',
    dialect: pgDialect,
    async query<R = unknown>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (closed) {
        throw new Error('altacore: cannot query a closed driver.');
      }
      const result = await pool.query<Record<string, unknown>>(sqlText, [
        ...params,
      ]);
      return {
        rows: result.rows as R[],
        rowCount: result.rowCount ?? 0,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
};
