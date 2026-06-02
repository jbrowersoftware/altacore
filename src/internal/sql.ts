import {
  buildWhere,
  renderExpr,
  type ExprRuntime,
  type SqlDialect,
} from './where.js';
import type {
  Aggregate,
  AnyJoin,
  CountOptions,
  DeleteOptions,
  OnPair,
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
// `any` for the alias-map parameter: the runtime path reads orderBy/groupBy/
// aggregate refs structurally (RefRuntime/ExprRuntime), so the precise alias
// map that the public overloads enforce isn't needed here.
export type SelectInput<T> = SelectOptions<T, any> & {
  join?: JoinsInput;
  aggregates?: readonly Aggregate<T, any>[];
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function ensureNonNegInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `altacore: ${name} must be a non-negative integer (got ${value}).`,
    );
  }
}

// Each clause that can carry an expression (orderBy, groupBy) returns its SQL
// fragment plus any params the expression bound (only `coalesce` binds today).
// `offset` continues placeholder numbering past prior clauses; `qualifier` is
// the outer table/alias that bare `{ col }` refs resolve against.
type ClausePart = { sql: string; params: unknown[] };

function buildOrderBy<T>(
  orderBy: SelectInput<T>['orderBy'],
  dialect: SqlDialect,
  qualifier: string | undefined,
  offset: number,
): ClausePart {
  if (!orderBy) return { sql: '', params: [] };
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (list.length === 0) return { sql: '', params: [] };
  const params: unknown[] = [];
  const parts = list.map((o) => {
    const dir = o.direction ?? 'asc';
    if (dir !== 'asc' && dir !== 'desc') {
      throw new TypeError(
        `altacore: invalid order direction "${String(dir)}". ` +
          `Expected 'asc' or 'desc'.`,
      );
    }
    // `o` carries `direction` too; renderExpr only reads col/alias/coalesce.
    const expr = renderExpr(o, dialect, qualifier, params, offset);
    return `${expr} ${dir.toUpperCase()}`;
  });
  return { sql: ` ORDER BY ${parts.join(', ')}`, params };
}

function buildGroupBy<T>(
  groupBy: SelectInput<T>['groupBy'],
  dialect: SqlDialect,
  qualifier: string | undefined,
  offset: number,
): ClausePart {
  if (!groupBy) return { sql: '', params: [] };
  const list = Array.isArray(groupBy) ? groupBy : [groupBy];
  if (list.length === 0) return { sql: '', params: [] };
  const params: unknown[] = [];
  const parts = list.map((e: ExprRuntime) =>
    renderExpr(e, dialect, qualifier, params, offset),
  );
  return { sql: ` GROUP BY ${parts.join(', ')}`, params };
}

type AggregateRuntime = {
  fn: 'count' | 'sum' | 'avg' | 'min' | 'max' | 'stringAgg';
  arg: '*' | ExprRuntime;
  distinct?: boolean;
  separator?: string;
  as: string;
};

// Aggregate projection fragments (`COUNT(DISTINCT "x") AS "n"`, …) appended to
// the SELECT list. COUNT/COUNT DISTINCT/SUM/AVG/MIN/MAX are standard across all
// three dialects. Any params an arg binds (only COALESCE today) are returned so
// the caller can place them first — projections precede every other clause.
function buildAggregates<T>(
  aggregates: SelectInput<T>['aggregates'],
  dialect: SqlDialect,
  qualifier: string | undefined,
  offset: number,
): ClausePart & { projections: string[] } {
  if (!aggregates || aggregates.length === 0) {
    return { sql: '', params: [], projections: [] };
  }
  const params: unknown[] = [];
  const projections = (aggregates as readonly AggregateRuntime[]).map((agg) => {
    const asQ = dialect.quoteIdentifier(agg.as);
    if (agg.fn === 'count' && agg.arg === '*') {
      return `COUNT(*) AS ${asQ}`;
    }
    // Non-'*' args are expressions; '*' is only valid for count (above).
    const col = renderExpr(
      agg.arg as ExprRuntime,
      dialect,
      qualifier,
      params,
      offset,
    );
    if (agg.fn === 'count') {
      return `COUNT(${agg.distinct ? 'DISTINCT ' : ''}${col}) AS ${asQ}`;
    }
    if (agg.fn === 'stringAgg') {
      // Separator is the only bound param; pushing it after the arg's params
      // keeps positional (mysql `?`) numbering consistent across dialects.
      params.push(agg.separator);
      const sep = dialect.placeholder(offset + params.length);
      return `${dialect.stringAgg(col, sep)} AS ${asQ}`;
    }
    return `${agg.fn.toUpperCase()}(${col}) AS ${asQ}`;
  });
  return { sql: '', params, projections };
}

type KeysetKeyRuntime = { expr: ExprRuntime; direction?: 'asc' | 'desc' };
type KeysetRuntime = {
  keys: readonly KeysetKeyRuntime[];
  after: readonly unknown[];
  limit?: number;
};

// Expanded lexicographic seek predicate for keyset pagination. For keys
// k0,k1,k2 (each asc/desc) and cursor values v0,v1,v2 it emits:
//   (k0 > v0) OR (k0 = v0 AND k1 > v1) OR (k0 = v0 AND k1 = v1 AND k2 > v2)
// `>` for asc, `<` for desc. The expanded form (vs. a row-value
// `(k0,k1) > (v0,v1)`) is portable — MSSQL has no row-value comparison.
function buildKeysetPredicate(
  keyset: KeysetRuntime,
  dialect: SqlDialect,
  qualifier: string | undefined,
  offset: number,
): ClausePart {
  const { keys, after } = keyset;
  if (keys.length === 0) {
    throw new TypeError(`altacore: keyset 'keys' cannot be empty.`);
  }
  if (after.length !== keys.length) {
    throw new TypeError(
      `altacore: keyset 'after' must supply one value per key ` +
        `(got ${after.length} value(s) for ${keys.length} key(s)).`,
    );
  }

  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return dialect.placeholder(offset + params.length);
  };

  const groups: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const terms: string[] = [];
    // Tie on every preceding key…
    for (let j = 0; j < i; j++) {
      const col = renderExpr(keys[j]!.expr, dialect, qualifier, params, offset);
      terms.push(`${col} = ${addParam(after[j])}`);
    }
    // …then a strict comparison on this key.
    const dir = keys[i]!.direction ?? 'asc';
    if (dir !== 'asc' && dir !== 'desc') {
      throw new TypeError(
        `altacore: invalid keyset direction "${String(dir)}". ` +
          `Expected 'asc' or 'desc'.`,
      );
    }
    const op = dir === 'asc' ? '>' : '<';
    const col = renderExpr(keys[i]!.expr, dialect, qualifier, params, offset);
    terms.push(`${col} ${op} ${addParam(after[i])}`);
    groups.push(terms.length > 1 ? `(${terms.join(' AND ')})` : terms[0]!);
  }

  // Multiple OR groups must be parenthesized so an outer `AND <where>` binds
  // correctly.
  const sql = groups.length > 1 ? `(${groups.join(' OR ')})` : groups[0]!;
  return { sql, params };
}

function normalizeJoins(j: JoinsInput | undefined): readonly AnyJoinInput[] {
  if (!j) return [];
  return Array.isArray(j)
    ? (j as readonly AnyJoinInput[])
    : [j as AnyJoinInput];
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

  // Keyset/cursor pagination handles its own LIMIT and ORDER BY, and pages
  // the joined result set directly (flat emission, never the subquery wrap).
  // Works with or without joins.
  if (options?.keyset) {
    return buildSelectKeyset(table, dialect, options, joins);
  }

  // Fast path: no joins — preserve the existing unqualified emission so
  // single-table behavior and tests are unchanged.
  if (joins.length === 0) {
    return buildSelectFlat(table, dialect, options);
  }

  // Paginated joins: subquery-wrap the outer table so LIMIT/OFFSET applies
  // to outer rows, not join-expanded result rows. Without the wrap, a 1:N
  // join with LIMIT 10 would return the first 10 join-pairs (a fraction of
  // outer rows). With it, LIMIT 10 inside the subquery limits outer rows
  // first, then joins fan out per matched outer row.
  if (options?.limit !== undefined || options?.offset !== undefined) {
    return buildSelectPaginatedJoin(table, dialect, options, joins);
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

  // Aggregate projections come first in SELECT text, so their params lead.
  const aggR = buildAggregates(options?.aggregates, dialect, table, 0);

  const joinChunk = buildJoinChain(
    table,
    '',
    joins,
    dialect,
    aggR.params.length,
  );
  projections.push(...joinChunk.projections, ...aggR.projections);

  // Param order follows clause order: aggregates, ON/where, GROUP BY, ORDER BY.
  const whereAfter = aggR.params.length + joinChunk.params.length;
  const whereR = buildWhere(options?.where, dialect, whereAfter, table);

  const groupAfter = whereAfter + whereR.params.length;
  const groupR = buildGroupBy(options?.groupBy, dialect, table, groupAfter);
  const orderR = buildOrderBy(
    options?.orderBy,
    dialect,
    table,
    groupAfter + groupR.params.length,
  );

  let sql = `SELECT ${projections.join(', ')} FROM ${tableQ}`;
  if (joinChunk.sql) sql += ` ${joinChunk.sql}`;
  if (whereR.sql) sql += ` WHERE ${whereR.sql}`;
  sql += groupR.sql;
  sql += orderR.sql;

  return {
    sql,
    params: [
      ...aggR.params,
      ...joinChunk.params,
      ...whereR.params,
      ...groupR.params,
      ...orderR.params,
    ],
  };
}

// The subquery `AS page` alias is the parent qualifier for the outermost
// joins' ON pairs and the outer projection prefix — it's an internal
// implementation detail, never visible to consumers.
const PAGE_ALIAS = 'page';

// The inner pagination subquery selects the outer table alone, so an orderBy
// entry that references a joined alias (`{ alias, col }`, or a `coalesce` over
// one) is unbound there — the alias only exists in the outer wrapper, around
// the join. Keep only outer-table refs for the inner ORDER BY; the full
// ordering is still applied on the outer wrapper. (Ordering the *page
// selection* by a joined column isn't expressible under subquery-wrap
// pagination — use keyset pagination for cross-table cursors.)
function outerOnlyOrderBy<T>(
  orderBy: SelectInput<T>['orderBy'],
): SelectInput<T>['orderBy'] {
  if (!orderBy) return orderBy;
  const list = Array.isArray(orderBy) ? orderBy : [orderBy];
  return list.filter((o) => {
    const entry = o as {
      alias?: string;
      coalesce?: readonly [{ alias?: string }, unknown];
    };
    const ref = entry.coalesce ? entry.coalesce[0] : entry;
    return ref.alias === undefined;
  });
}

function buildSelectPaginatedJoin<T>(
  table: string,
  dialect: SqlDialect,
  options: SelectInput<T>,
  joins: readonly AnyJoinInput[],
): SqlBuilt {
  // The inner subquery uses SELECT * so any column referenced by a join's
  // ON pair (or the outer projection) is available on the `page` alias.
  // Trade-off: the subquery materializes all outer columns regardless of
  // projection. Worth it for v1 simplicity.
  const subquery = buildSelectFlat(table, dialect, {
    where: options.where,
    // Outer-table refs only — alias-qualified refs are unbound inside the
    // subquery (they resolve only on the outer wrapper, below).
    orderBy: outerOnlyOrderBy(options.orderBy),
    limit: options.limit,
    offset: options.offset,
  });

  const pageQ = dialect.quoteIdentifier(PAGE_ALIAS);

  // Outer projection — qualify by the subquery alias.
  const projections: string[] = [];
  const outerCols = options.columns;
  if (outerCols === undefined) {
    projections.push(`${pageQ}.*`);
  } else {
    if (outerCols.length === 0) {
      throw new TypeError(
        `altacore: select 'columns' cannot be empty. ` +
          `Omit the property to select all columns.`,
      );
    }
    for (const c of outerCols) {
      projections.push(`${pageQ}.${dialect.quoteIdentifier(c)}`);
    }
  }

  // Joins reference `page` (not the original table name) as the parent
  // qualifier. Param numbering continues past the subquery's params.
  const joinChunk = buildJoinChain(
    PAGE_ALIAS,
    '',
    joins,
    dialect,
    subquery.params.length,
  );
  projections.push(...joinChunk.projections);

  // Outer ORDER BY for result-row ordering (the inner ORDER BY drives the
  // pagination, but the join's row expansion can reshuffle without an
  // outer ORDER BY). Qualify with the page alias to disambiguate; refs that
  // name a join alias keep their own qualifier (the join is in the outer query).
  const outerOrderR = buildOrderBy(
    options.orderBy,
    dialect,
    PAGE_ALIAS,
    subquery.params.length + joinChunk.params.length,
  );

  let sql = `SELECT ${projections.join(', ')} FROM (${subquery.sql}) AS ${pageQ}`;
  if (joinChunk.sql) sql += ` ${joinChunk.sql}`;
  sql += outerOrderR.sql;

  return {
    sql,
    params: [...subquery.params, ...joinChunk.params, ...outerOrderR.params],
  };
}

const EMPTY_COLUMNS_ERROR =
  `altacore: select 'columns' cannot be empty. ` +
  `Omit the property to select all columns.`;

// Keyset/cursor pagination. Emits a flat (non-subquery-wrapped) query so the
// seek predicate and LIMIT page the joined result set directly — the right
// semantics for cursoring through ordered result rows. Works with or without
// joins; the seek keys and ORDER BY are derived from the same `keys` array.
function buildSelectKeyset<T>(
  table: string,
  dialect: SqlDialect,
  options: SelectInput<T>,
  joins: readonly AnyJoinInput[],
): SqlBuilt {
  if (options.limit !== undefined || options.offset !== undefined) {
    throw new TypeError(
      `altacore: 'keyset' cannot be combined with 'limit'/'offset'. ` +
        `Use 'keyset.limit' to cap the page size.`,
    );
  }
  const keyset = options.keyset as KeysetRuntime;
  const tableQ = dialect.quoteIdentifier(table);
  const hasJoins = joins.length > 0;
  // Bare `{ col }` refs qualify by the outer table only when joins are present;
  // single-table stays unqualified (matching the flat path).
  const qualifier = hasJoins ? table : undefined;

  // Outer projection.
  const projections: string[] = [];
  const outerCols = options.columns;
  if (outerCols !== undefined && outerCols.length === 0) {
    throw new TypeError(EMPTY_COLUMNS_ERROR);
  }
  if (outerCols === undefined) {
    projections.push(hasJoins ? `${tableQ}.*` : '*');
  } else {
    for (const c of outerCols) {
      const colQ = dialect.quoteIdentifier(c);
      projections.push(hasJoins ? `${tableQ}.${colQ}` : colQ);
    }
  }

  // Aggregate projections lead the param list (they appear first in SELECT).
  const aggR = buildAggregates(options.aggregates, dialect, qualifier, 0);

  const joinChunk = hasJoins
    ? buildJoinChain(table, '', joins, dialect, aggR.params.length)
    : { sql: '', projections: [] as string[], params: [] as unknown[] };
  projections.push(...joinChunk.projections, ...aggR.projections);

  // WHERE = regular predicate AND keyset seek predicate.
  const whereAfter = aggR.params.length + joinChunk.params.length;
  const whereR = buildWhere(
    options.where,
    dialect,
    whereAfter,
    qualifier,
    table,
  );
  const seekOffset = whereAfter + whereR.params.length;
  const seek = buildKeysetPredicate(keyset, dialect, qualifier, seekOffset);
  const whereSql =
    whereR.sql && seek.sql
      ? `${whereR.sql} AND ${seek.sql}`
      : whereR.sql || seek.sql;

  // GROUP BY, then ORDER BY (from the same keys — consistent with the seek).
  const groupAfter = seekOffset + seek.params.length;
  const groupR = buildGroupBy(options.groupBy, dialect, qualifier, groupAfter);
  const orderList = keyset.keys.map((k) => ({
    ...k.expr,
    direction: k.direction,
  })) as SelectInput<T>['orderBy'];
  const orderR = buildOrderBy(
    orderList,
    dialect,
    qualifier,
    groupAfter + groupR.params.length,
  );

  let sql = `SELECT ${projections.join(', ')} FROM ${tableQ}`;
  if (joinChunk.sql) sql += ` ${joinChunk.sql}`;
  if (whereSql) sql += ` WHERE ${whereSql}`;
  sql += groupR.sql;
  sql += orderR.sql;

  if (keyset.limit !== undefined) {
    ensureNonNegInt(keyset.limit, 'keyset.limit');
    // Keyset always has an ORDER BY, so MSSQL needs no synthetic one.
    sql += dialect.formatLimitOffset(keyset.limit, undefined, true);
  }

  return {
    sql,
    params: [
      ...aggR.params,
      ...joinChunk.params,
      ...whereR.params,
      ...seek.params,
      ...groupR.params,
      ...orderR.params,
    ],
  };
}

function buildSelectFlat<T>(
  table: string,
  dialect: SqlDialect,
  options?: SelectInput<T>,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  // Single-table path: bare `{ col }` refs stay unqualified (existing
  // behavior). Projection comes first in the SQL text, so aggregate params are
  // numbered before WHERE/GROUP BY/ORDER BY.
  const aggR = buildAggregates(options?.aggregates, dialect, undefined, 0);
  // outerTable = table: single-table refs stay unqualified, but EXISTS
  // correlation still needs the table name to disambiguate the subquery.
  const where = buildWhere(
    options?.where,
    dialect,
    aggR.params.length,
    undefined,
    table,
  );
  const groupR = buildGroupBy(
    options?.groupBy,
    dialect,
    undefined,
    aggR.params.length + where.params.length,
  );
  const orderR = buildOrderBy(
    options?.orderBy,
    dialect,
    undefined,
    aggR.params.length + where.params.length + groupR.params.length,
  );

  const columns = options?.columns;
  const projections: string[] = [];
  if (columns === undefined) {
    projections.push('*');
  } else {
    if (columns.length === 0) {
      throw new TypeError(EMPTY_COLUMNS_ERROR);
    }
    projections.push(...columns.map((c) => dialect.quoteIdentifier(c)));
  }
  projections.push(...aggR.projections);

  let sql = `SELECT ${projections.join(', ')} FROM ${tableQ}`;
  if (where.sql) sql += ` WHERE ${where.sql}`;
  sql += groupR.sql;
  sql += orderR.sql;

  if (options?.limit !== undefined) ensureNonNegInt(options.limit, 'limit');
  if (options?.offset !== undefined) ensureNonNegInt(options.offset, 'offset');

  sql += dialect.formatLimitOffset(
    options?.limit,
    options?.offset,
    orderR.sql !== '',
  );

  return {
    sql,
    params: [
      ...aggR.params,
      ...where.params,
      ...groupR.params,
      ...orderR.params,
    ],
  };
}

export function buildCount<T>(
  table: string,
  dialect: SqlDialect,
  options?: CountOptions<T>,
): SqlBuilt {
  const tableQ = dialect.quoteIdentifier(table);
  const joins = normalizeJoins(options?.join);

  if (joins.length === 0) {
    const where = buildWhere(options?.where, dialect, 0, undefined, table);
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
