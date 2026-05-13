import { buildWhere, type SqlDialect } from './where.js';
import type {
  CountOptions,
  DeleteOptions,
  OrderBy,
  SelectOptions,
  UpdateOptions,
} from '../core/dbCore.js';

export type SqlBuilt = {
  sql: string;
  params: unknown[];
};

function ensureNonNegInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `altacore: ${name} must be a non-negative integer (got ${value}).`,
    );
  }
}

function formatOrderBy<T>(
  orderBy: OrderBy<T> | OrderBy<T>[] | undefined,
  dialect: SqlDialect,
): string {
  if (!orderBy) return '';
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (list.length === 0) return '';
  const parts = list.map((o) => {
    const col = dialect.quoteIdentifier(o.col);
    const dir = o.direction ?? 'asc';
    if (dir !== 'asc' && dir !== 'desc') {
      throw new TypeError(
        `altacore: invalid order direction "${String(dir)}". ` +
          `Expected 'asc' or 'desc'.`,
      );
    }
    return `${col} ${dir.toUpperCase()}`;
  });
  return ` ORDER BY ${parts.join(', ')}`;
}

export function buildSelect<T>(
  table: string,
  dialect: SqlDialect,
  options?: SelectOptions<T>,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const where = buildWhere(options?.where, dialect);
  const orderClause = formatOrderBy(options?.orderBy, dialect);

  const columns = options?.columns;
  let projection: string;
  if (columns === undefined) {
    projection = '*';
  } else {
    if (columns.length === 0) {
      throw new TypeError(
        `altacore: select 'columns' cannot be empty. ` +
          `Omit the property to select all columns.`,
      );
    }
    projection = columns.map((c) => dialect.quoteIdentifier(c)).join(', ');
  }

  let sql = `SELECT ${projection} FROM ${tableQ}`;
  if (where.sql) sql += ` WHERE ${where.sql}`;
  sql += orderClause;

  if (options?.limit !== undefined) ensureNonNegInt(options.limit, 'limit');
  if (options?.offset !== undefined) ensureNonNegInt(options.offset, 'offset');

  sql += dialect.formatLimitOffset(
    options?.limit,
    options?.offset,
    orderClause !== '',
  );

  return { sql, params: where.params };
}

export function buildCount<T>(
  table: string,
  dialect: SqlDialect,
  options?: CountOptions<T>,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const where = buildWhere(options?.where, dialect);

  let sql = `SELECT COUNT(*) AS count FROM ${tableQ}`;
  if (where.sql) sql += ` WHERE ${where.sql}`;

  return { sql, params: where.params };
}

export function buildInsert<T>(
  table: string,
  dialect: SqlDialect,
  values: Partial<T>,
  returnRows = false,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const entries = Object.entries(values as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );

  if (entries.length === 0) {
    throw new TypeError(`altacore: insert requires at least one column value.`);
  }

  const params: unknown[] = [];
  const cols = entries.map(([k]) => dialect.quoteIdentifier(k)).join(', ');
  const placeholders = entries
    .map(([, v]) => {
      params.push(v);
      return dialect.placeholder(params.length);
    })
    .join(', ');

  let sql: string;
  if (returnRows && dialect.returningStrategy === 'output') {
    // mssql: OUTPUT goes between (cols) and VALUES.
    sql = `INSERT INTO ${tableQ} (${cols}) OUTPUT INSERTED.* VALUES (${placeholders})`;
  } else if (returnRows && dialect.returningStrategy === 'returning') {
    sql = `INSERT INTO ${tableQ} (${cols}) VALUES (${placeholders}) RETURNING *`;
  } else {
    sql = `INSERT INTO ${tableQ} (${cols}) VALUES (${placeholders})`;
  }

  return { sql, params };
}

export function buildUpdate<T>(
  table: string,
  dialect: SqlDialect,
  options: UpdateOptions<T>,
  returnRows = false,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const setEntries = Object.entries(
    options.set as Record<string, unknown>,
  ).filter(([, v]) => v !== undefined);

  if (setEntries.length === 0) {
    throw new TypeError(
      `altacore: update requires at least one column in 'set'.`,
    );
  }

  const params: unknown[] = [];
  const setParts: string[] = [];

  for (const [col, value] of setEntries) {
    const colQ = dialect.quoteIdentifier(col);
    if (value === null) {
      setParts.push(`${colQ} = NULL`);
    } else {
      params.push(value);
      setParts.push(`${colQ} = ${dialect.placeholder(params.length)}`);
    }
  }

  // Continue placeholder numbering past the SET params.
  const where = buildWhere(options.where, dialect, params.length);

  if (!where.sql) {
    throw new TypeError(
      `altacore: update requires a non-empty 'where' clause ` +
        `(refusing to update all rows). Pass an explicit condition.`,
    );
  }

  const setSql = setParts.join(', ');
  let sql: string;
  if (returnRows && dialect.returningStrategy === 'output') {
    // mssql: OUTPUT goes between SET and WHERE.
    sql = `UPDATE ${tableQ} SET ${setSql} OUTPUT INSERTED.* WHERE ${where.sql}`;
  } else if (returnRows && dialect.returningStrategy === 'returning') {
    sql = `UPDATE ${tableQ} SET ${setSql} WHERE ${where.sql} RETURNING *`;
  } else {
    sql = `UPDATE ${tableQ} SET ${setSql} WHERE ${where.sql}`;
  }
  return { sql, params: [...params, ...where.params] };
}

export function buildDelete<T>(
  table: string,
  dialect: SqlDialect,
  options: DeleteOptions<T>,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const where = buildWhere(options.where, dialect);

  if (!where.sql) {
    throw new TypeError(
      `altacore: delete requires a non-empty 'where' clause ` +
        `(refusing to delete all rows). Pass an explicit condition.`,
    );
  }

  return {
    sql: `DELETE FROM ${tableQ} WHERE ${where.sql}`,
    params: where.params,
  };
}
