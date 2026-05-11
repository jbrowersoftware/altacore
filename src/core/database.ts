export type DatabaseDriver = 'pg' | 'mysql' | 'mssql';

export type DatabaseConfig = {
  driver: DatabaseDriver;
  connectionString: string;
};

export type Database = {
  readonly driver: DatabaseDriver;
};

export function createDatabase(config: DatabaseConfig): Database {
  return {
    driver: config.driver,
  };
}
