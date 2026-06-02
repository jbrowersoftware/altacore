export { createDatabase } from './core/database.js';
export type {
  Database,
  DatabaseConfig,
  DatabaseDriver,
  PoolConfig,
} from './core/database.js';

export { createDbCore } from './core/dbCore.js';
export type {
  Aggregate,
  AnyJoin,
  ColRef,
  CountOptions,
  DbCore,
  DeleteOptions,
  ExistsSpec,
  Expr,
  JoinSelect,
  JoinSpec,
  JoinType,
  Keyset,
  KeysetKey,
  OnPair,
  OnSpec,
  OrderBy,
  SelectFn,
  SelectOptions,
  SelectWithCountFn,
  UpdateOptions,
  Where,
  WhereCondition,
  WhereOperators,
} from './core/dbCore.js';

export type { Driver, DriverFactory, QueryResult } from './drivers/types.js';

export const VERSION = '0.1.1';
