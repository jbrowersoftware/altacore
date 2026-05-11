import { describe, expect, it } from 'vitest';
import { buildWhere, type SqlDialect } from './where.js';

const pg: SqlDialect = {
  placeholder: (i) => `$${i}`,
  quoteIdentifier: (name) => `"${name}"`,
  formatLimitOffset: () => '',
  returningStrategy: 'none',
};

const mysql: SqlDialect = {
  placeholder: () => '?',
  quoteIdentifier: (name) => `\`${name}\``,
  formatLimitOffset: () => '',
  returningStrategy: 'none',
};

type Row = {
  id: number;
  name: string;
  age: number;
  active: boolean;
  bio: string | null;
};

describe('buildWhere', () => {
  it('returns empty for undefined input', () => {
    expect(buildWhere<Row>(undefined, pg)).toEqual({ sql: '', params: [] });
  });

  it('returns empty for empty object', () => {
    expect(buildWhere<Row>({}, pg)).toEqual({ sql: '', params: [] });
  });

  it('treats bare value as equality', () => {
    expect(buildWhere<Row>({ id: 1 }, pg)).toEqual({
      sql: '"id" = $1',
      params: [1],
    });
  });

  it('joins multiple bare values with AND', () => {
    const r = buildWhere<Row>({ id: 1, name: 'foo' }, pg);
    expect(r.sql).toBe('"id" = $1 AND "name" = $2');
    expect(r.params).toEqual([1, 'foo']);
  });

  it('renders comparison operators', () => {
    const r = buildWhere<Row>({ age: { gt: 18, lte: 65 }, id: { ne: 0 } }, pg);
    expect(r.sql).toBe('"age" > $1 AND "age" <= $2 AND "id" <> $3');
    expect(r.params).toEqual([18, 65, 0]);
  });

  it('renders LIKE', () => {
    expect(buildWhere<Row>({ name: { like: 'a%' } }, pg)).toEqual({
      sql: '"name" LIKE $1',
      params: ['a%'],
    });
  });

  it('renders IN', () => {
    expect(buildWhere<Row>({ id: { in: [1, 2, 3] } }, pg)).toEqual({
      sql: '"id" IN ($1, $2, $3)',
      params: [1, 2, 3],
    });
  });

  it('renders NOT IN', () => {
    expect(buildWhere<Row>({ id: { nin: [1, 2] } }, pg)).toEqual({
      sql: '"id" NOT IN ($1, $2)',
      params: [1, 2],
    });
  });

  it('treats empty IN as always-false', () => {
    expect(buildWhere<Row>({ id: { in: [] } }, pg)).toEqual({
      sql: '1 = 0',
      params: [],
    });
  });

  it('treats empty NOT IN as always-true', () => {
    expect(buildWhere<Row>({ id: { nin: [] } }, pg)).toEqual({
      sql: '1 = 1',
      params: [],
    });
  });

  it('translates eq null to IS NULL', () => {
    expect(buildWhere<Row>({ bio: { eq: null } }, pg)).toEqual({
      sql: '"bio" IS NULL',
      params: [],
    });
  });

  it('translates ne null to IS NOT NULL', () => {
    expect(buildWhere<Row>({ bio: { ne: null } }, pg)).toEqual({
      sql: '"bio" IS NOT NULL',
      params: [],
    });
  });

  it('translates bare null to IS NULL', () => {
    expect(buildWhere<Row>({ bio: null }, pg)).toEqual({
      sql: '"bio" IS NULL',
      params: [],
    });
  });

  it('mixes bare and operator forms across columns', () => {
    const r = buildWhere<Row>({ id: 1, age: { gt: 18 } }, pg);
    expect(r.sql).toBe('"id" = $1 AND "age" > $2');
    expect(r.params).toEqual([1, 18]);
  });

  it('skips undefined column conditions', () => {
    const r = buildWhere<Row>({ id: undefined, name: 'foo' }, pg);
    expect(r.sql).toBe('"name" = $1');
    expect(r.params).toEqual(['foo']);
  });

  it('skips undefined operator values', () => {
    const r = buildWhere<Row>({ age: { gt: undefined, lte: 65 } }, pg);
    expect(r.sql).toBe('"age" <= $1');
    expect(r.params).toEqual([65]);
  });

  it('uses dialect-specific placeholders and quoting', () => {
    const r = buildWhere<Row>({ id: 1, name: 'foo' }, mysql);
    expect(r.sql).toBe('`id` = ? AND `name` = ?');
    expect(r.params).toEqual([1, 'foo']);
  });

  // The Row type above models `bio: string | null`; these cases also need to
  // typecheck on rows that follow the `?:` convention (V = string | undefined)
  // and on strictly non-null columns. Type-only assertions: if these compile
  // without `as` casts, the typing gap is closed.
  type StrictRow = { id: number; name: string };
  type OptionalRow = { id: number; bio?: string };

  it('eq null typechecks on a strictly non-null column', () => {
    expect(buildWhere<StrictRow>({ id: { eq: null } }, pg)).toEqual({
      sql: '"id" IS NULL',
      params: [],
    });
  });

  it('bare null typechecks on a strictly non-null column', () => {
    expect(buildWhere<StrictRow>({ id: null }, pg)).toEqual({
      sql: '"id" IS NULL',
      params: [],
    });
  });

  it('eq null typechecks on an optional (?:) column', () => {
    expect(buildWhere<OptionalRow>({ bio: { eq: null } }, pg)).toEqual({
      sql: '"bio" IS NULL',
      params: [],
    });
  });

  it('ne null typechecks on an optional (?:) column', () => {
    expect(buildWhere<OptionalRow>({ bio: { ne: null } }, pg)).toEqual({
      sql: '"bio" IS NOT NULL',
      params: [],
    });
  });

  it('throws on unknown operator', () => {
    expect(() =>
      // @ts-expect-error testing runtime guard against a non-typed operator
      buildWhere<Row>({ age: { greaterThan: 18 } }, pg),
    ).toThrow(/unknown operator "greaterThan"/);
  });

  it('throws when in/nin given a non-array', () => {
    expect(() =>
      // @ts-expect-error testing runtime guard
      buildWhere<Row>({ id: { in: 1 } }, pg),
    ).toThrow(/expects an array/);
  });
});
