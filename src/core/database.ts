import { DIALECTS } from '../internal/dialect.js';
import { nullsToUndefined } from '../internal/normalize.js';
import type { Driver, QueryResult } from '../drivers/types.js';

export type DatabaseDriver = 'pg' | 'mysql' | 'mssql';

// Common pool sizing knobs forwarded to the underlying driver. Anything
// outside this small set should be configured by constructing the driver
// directly. `min` is honored on pg + mssql and ignored on mysql (mysql2
// has no minimum-idle equivalent).
export type PoolConfig = {
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
};

export type DatabaseConfig = {
  driver: DatabaseDriver;
  connectionString: string;
  pool?: PoolConfig;
};

export type Database = {
  readonly driver: Driver;
};

export function createDatabase(config: DatabaseConfig): Database {
  return {
    driver: createLazyDriver(config),
  };
}

// Returned synchronously: kind + dialect are available immediately so SQL
// composition never has to await. The real backend driver is loaded on the
// first query() call and cached. Concurrent first calls share one load.
function createLazyDriver(config: DatabaseConfig): Driver {
  const kind = config.driver;
  const dialect = DIALECTS[kind];

  let real: Driver | null = null;
  let loading: Promise<Driver> | null = null;

  const ensure = (): Promise<Driver> => {
    if (real) return Promise.resolve(real);
    if (loading) return loading;
    loading = loadDriver(config).then((d) => {
      real = d;
      loading = null;
      return d;
    });
    return loading;
  };

  return {
    kind,
    dialect,
    async query<R = unknown>(
      sql: string,
      params: readonly unknown[],
    ): Promise<QueryResult<R>> {
      const driver = await ensure();
      const raw = await driver.query<R>(sql, params);
      return {
        rows: raw.rows.map((r) => nullsToUndefined(r)),
        rowCount: raw.rowCount,
      };
    },
    async close() {
      if (real) await real.close();
    },
  };
}

async function loadDriver(config: DatabaseConfig): Promise<Driver> {
  const kind = config.driver;
  switch (kind) {
    case 'pg': {
      const mod = await import('../drivers/pg.js');
      return mod.createPgDriver(config);
    }
    case 'mysql': {
      const mod = await import('../drivers/mysql.js');
      return mod.createMysqlDriver(config);
    }
    case 'mssql': {
      const mod = await import('../drivers/mssql.js');
      return mod.createMssqlDriver(config);
    }
    default: {
      // Compile-time check
      const exhaustive: never = kind;
      // Run-time check
      throw new Error(`altacore: unknown driver "${String(exhaustive)}".`);
    }
  }
}
