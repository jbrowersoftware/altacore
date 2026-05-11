import mssql from 'mssql';

import type { DatabaseConfig } from '../core/database.js';
import { mssqlDialect } from '../internal/dialect.js';
import type { Driver, DriverFactory, QueryResult } from './types.js';

export const createMssqlDriver: DriverFactory = (
  config: DatabaseConfig,
): Driver => {
  const pool = new mssql.ConnectionPool(config.connectionString);

  // The connection string is parsed in the constructor; layer pool overrides
  // onto the resulting config before connect() runs. `config` exists at
  // runtime but isn't exposed by @types/mssql, so we narrow through unknown.
  if (config.pool) {
    type PoolConfigInternal = {
      max?: number;
      min?: number;
      idleTimeoutMillis?: number;
    };
    const internal = pool as unknown as {
      config: { pool?: PoolConfigInternal };
    };
    internal.config.pool = {
      ...internal.config.pool,
      ...(config.pool.max !== undefined && { max: config.pool.max }),
      ...(config.pool.min !== undefined && { min: config.pool.min }),
      ...(config.pool.idleTimeoutMillis !== undefined && {
        idleTimeoutMillis: config.pool.idleTimeoutMillis,
      }),
    };
  }

  // Kick off the connect; share one promise across concurrent first queries.
  const ready = pool.connect();
  // Avoid an unhandled rejection if the consumer never queries before close.
  ready.catch(() => undefined);

  let closed = false;

  return {
    kind: 'mssql',
    dialect: mssqlDialect,
    async query<R = unknown>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (closed) {
        throw new Error('altacore: cannot query a closed driver.');
      }
      await ready;
      const request = pool.request();
      params.forEach((value, i) => {
        request.input(`p${i + 1}`, value);
      });
      const result = await request.query<R>(sqlText);
      const recordset = result.recordset;
      const rows: R[] = recordset ?? [];
      const affected = (result.rowsAffected ?? []).reduce((a, b) => a + b, 0);
      return {
        rows,
        rowCount: recordset ? rows.length : affected,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await ready;
      } catch {
        // pool failed to connect; pool.close() is still safe to call.
      }
      await pool.close();
    },
  };
};
