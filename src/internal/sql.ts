import { buildWhere, type SqlDialect } from './where.js';
import type {
  AnyJoin,
  CountOptions,
  DeleteOptions,
  OnPair,
  OrderBy,
  SelectOptions,
  UpdateOptions,
} from '../core/dbCore.js';

export type SqlBuilt = {
  sql: string;
  params: unknown[];
};

// Wider input types for the builders — `join` is added here, not on public
// SelectOptions, so the SelectFn return-type narrowing isn't undermined by
// variables explicitly typed as SelectOptions<T>. CountOptions exposes
// `join?` publicly since `count()` has only one overload (no narrowing path).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyJoinInput = AnyJoin<any>;
type JoinsInput = AnyJoinInput | readonly AnyJoinInput[];
export type SelectInput<T> = SelectOptions<T> & { join?: JoinsInput };
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  qualifier?: string,
): string {
  if (!orderBy) return '';
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (list.length === 0) return '';
  const prefix = qualifier ? `${dialect.quoteIdentifier(qualifier)}.` : '';
  const parts = list.map((o) => {
    const col = `${prefix}${dialect.quoteIdentifier(o.col)}`;
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

function normalizeJoins(j: JoinsInput | undefined): readonly AnyJoinInput[] {
  if (!j) return [];
  return Array.isArray(j) ? (j as readonly AnyJoinInput[]) : [j as AnyJoinInput];
}

function normalizeOnPairs(
  on: AnyJoinInput['on'],
): readonly OnPair<unknown, unknown>[] {
  // OnSpec is OnPair | readonly OnPair[]. OnPair = [string, string]. Tell
  // them apart by whether the first element is itself an array.
  if (on.length === 0) {
    throw new TypeError(`altacore: join 'on' cannot be empty.`);
  }
  const first = on[0];
  if (Array.isArray(first)) {
    return on as readonly OnPair<unknown, unknown>[];
  }
  return [on as OnPair<unknown, unknown>];
}

// One join clause's accumulated output. The recursive walker hands its
// projections up the chain so the outer SELECT can build a single column
// list, and threads `paramCount` through every ON-AND predicate.
type JoinChunk = {
  sql: string; // joined clauses, space-separated, no leading space
  projections: readonly string[];
  params: readonly unknown[];
};

function buildJoinChain(
  parentQualifier: string,
  parentAliasPath: string,
  joins: readonly AnyJoinInput[],
  dialect: SqlDialect,
  startParamCount: number,
): JoinChunk {
  const projections: string[] = [];
  const params: unknown[] = [];
  const sqls: string[] = [];
  let paramCount = startParamCount;

  for (const join of joins) {
    const chunk = buildOneJoin(
      parentQualifier,
      parentAliasPath,
      join,
      dialect,
      paramCount,
    );
    sqls.push(chunk.sql);
    projections.push(...chunk.projections);
    params.push(...chunk.params);
    paramCount += chunk.params.length;
  }

  return { sql: sqls.join(' '), projections, params };
}

const JOIN_KEYWORD: Record<NonNullable<AnyJoinInput['type']>, string> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL JOIN',
};

function buildOneJoin(
  parentQualifier: string,
  parentAliasPath: string,
  join: AnyJoinInput,
  dialect: SqlDialect,
  startParamCount: number,
): JoinChunk {
  // Full path from the root, joined by dots — used for the AS aliases on
  // projections so the result row keys form one consistent dotted-path
  // namespace (`o.id`, `o.it.id`). This is distinct from `parentQualifier`,
  // which is the IMMEDIATE parent's alias/table-name and used for ON-pair
  // column references (`"o"."id" = "it"."orderId"`) — SQL doesn't accept
  // dotted-name parents like `"o.it"."id"`.
  const aliasPath = parentAliasPath
    ? `${parentAliasPath}.${join.alias}`
    : join.alias;
  const joinType = join.type ?? 'inner';
  const keyword = JOIN_KEYWORD[joinType];
  if (!keyword) {
    throw new TypeError(
      `altacore: invalid join type "${String(joinType)}". ` +
        `Expected one of: inner, left, right, full.`,
    );
  }

  const tableQ = dialect.quoteIdentifier(join.table.tableName);
  const aliasQ = dialect.quoteIdentifier(join.alias);
  const parentQ = dialect.quoteIdentifier(parentQualifier);

  // ON pairs — every pair contributes `<parent>.<col> = <alias>.<col>`.
  const onPairs = normalizeOnPairs(join.on);
  const onSqls: string[] = onPairs.map(([leftCol, rightCol]) => {
    const left = `${parentQ}.${dialect.quoteIdentifier(leftCol)}`;
    const right = `${aliasQ}.${dialect.quoteIdentifier(rightCol)}`;
    return `${left} = ${right}`;
  });

  const params: unknown[] = [];
  let paramCount = startParamCount;

  // ON-AND-where — predicates from join.select.where land inside the ON
  // clause, qualified by the alias. This is the LEFT-safe placement.
  if (join.select?.where) {
    const w = buildWhere(join.select.where, dialect, paramCount, join.alias);
    if (w.sql) {
      onSqls.push(w.sql);
      params.push(...w.params);
      paramCount += w.params.length;
    }
  }

  // Projections — alias-prefixed, with AS using a dotted identifier so the
  // result mapper can split flat row keys on '.' to nest by alias.
  const projections: string[] = [];
  const cols = join.select?.columns;
  if (cols) {
    if (cols.length === 0) {
      throw new TypeError(
        `altacore: join 'select.columns' cannot be empty for alias ` +
          `"${join.alias}". Omit the property or pass at least one column.`,
      );
    }
    for (const col of cols) {
      const colQ = dialect.quoteIdentifier(col);
      const aliased = dialect.quoteIdentifier(`${aliasPath}.${col}`);
      projections.push(`${aliasQ}.${colQ} AS ${aliased}`);
    }
  }

  // Nested joins recurse with this join's alias as the immediate parent
  // qualifier (for ON pairs) and the cumulative aliasPath as the projection
  // path prefix.
  const nestedJoins = normalizeJoins(join.select?.join);
  let nestedChunk: JoinChunk = { sql: '', projections: [], params: [] };
  if (nestedJoins.length > 0) {
    nestedChunk = buildJoinChain(
      join.alias,
      aliasPath,
      nestedJoins,
      dialect,
      paramCount,
    );
    paramCount += nestedChunk.params.length;
  }

  let sql = `${keyword} ${tableQ} AS ${aliasQ} ON ${onSqls.join(' AND ')}`;
  if (nestedChunk.sql) sql += ` ${nestedChunk.sql}`;

  return {
    sql,
    projections: [...projections, ...nestedChunk.projections],
    params: [...params, ...nestedChunk.params],
  };
}

export function buildSelect<T>(
  table: string,
  dialect: SqlDialect,
  options?: SelectInput<T>,
): SqlBuilt {
  const joins = normalizeJoins(options?.join);

  // Fast path: no joins — preserve the existing unqualified emission so
  // single-table behavior and tests are unchanged.
  if (joins.length === 0) {
    return buildSelectFlat(table, dialect, options);
  }

  const tableQ = dialect.quoteIdentifier(table);

  // Outer projection — qualified by the outer table name. When columns is
  // omitted, fall back to `<table>.*`.
  const outerCols = options?.columns;
  const projections: string[] = [];
  if (outerCols === undefined) {
    projections.push(`${tableQ}.*`);
  } else {
    if (outerCols.length === 0) {
      throw new TypeError(
        `altacore: select 'columns' cannot be empty. ` +
          `Omit the property to select all columns.`,
      );
    }
    for (const c of outerCols) {
      projections.push(`${tableQ}.${dialect.quoteIdentifier(c)}`);
    }
  }

  const joinChunk = buildJoinChain(table, '', joins, dialect, 0);
  projections.push(...joinChunk.projections);

  const whereR = buildWhere(
    options?.where,
    dialect,
    joinChunk.params.length,
    table,
  );

  const orderClause = formatOrderBy(options?.orderBy, dialect, table);

  if (options?.limit !== undefined) ensureNonNegInt(options.limit, 'limit');
  if (options?.offset !== undefined) ensureNonNegInt(options.offset, 'offset');

  let sql = `SELECT ${projections.join(', ')} FROM ${tableQ}`;
  if (joinChunk.sql) sql += ` ${joinChunk.sql}`;
  if (whereR.sql) sql += ` WHERE ${whereR.sql}`;
  sql += orderClause;
  sql += dialect.formatLimitOffset(
    options?.limit,
    options?.offset,
    orderClause !== '',
  );

  return { sql, params: [...joinChunk.params, ...whereR.params] };
}

function buildSelectFlat<T>(
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
  const joins = normalizeJoins(options?.join);

  if (joins.length === 0) {
    const where = buildWhere(options?.where, dialect);
    let sql = `SELECT COUNT(*) AS count FROM ${tableQ}`;
    if (where.sql) sql += ` WHERE ${where.sql}`;
    return { sql, params: where.params };
  }

  // Joined count: COUNT(*) over the joined result. The join's
  // `select.columns` is irrelevant for COUNT — projections are dropped.
  const joinChunk = buildJoinChain(table, '', joins, dialect, 0);
  const whereR = buildWhere(
    options?.where,
    dialect,
    joinChunk.params.length,
    table,
  );

  let sql = `SELECT COUNT(*) AS count FROM ${tableQ}`;
  if (joinChunk.sql) sql += ` ${joinChunk.sql}`;
  if (whereR.sql) sql += ` WHERE ${whereR.sql}`;

  return { sql, params: [...joinChunk.params, ...whereR.params] };
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
