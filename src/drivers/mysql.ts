import { createPool } from 'mysql2/promise';
import type { ResultSetHeader } from 'mysql2/promise';

import type { DatabaseConfig } from '../core/database.js';
import { mysqlDialect } from '../internal/dialect.js';
import type { Driver, DriverFactory, QueryResult } from './types.js';

export const createMysqlDriver: DriverFactory = (
  config: DatabaseConfig,
): Driver => {
  const pool = createPool(config.connectionString);

  let closed = false;

  return {
    kind: 'mysql',
    dialect: mysqlDialect,
    async query<R = unknown>(
      sqlText: string,
      params: readonly unknown[],
    ): Promise<QueryResult<R>> {
      if (closed) {
        throw new Error('altacore: cannot query a closed driver.');
      }
      // mysql2 types execute() params more strictly than our `unknown[]`;
      // values are runtime-safe, they come from the SQL builder.
      const [result] = await pool.execute(sqlText, [
        ...params,
      ] as unknown as Parameters<typeof pool.execute>[1]);

      // SELECT returns an array of row packets; INSERT/UPDATE/DELETE returns a
      // ResultSetHeader with affectedRows. Discriminate at runtime.
      if (Array.isArray(result)) {
        const rows = result as R[];
        return { rows, rowCount: rows.length };
      }
      const header = result as ResultSetHeader;
      return {
        rows: [],
        rowCount: header.affectedRows,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
};
