import { describe, expect, it } from 'vitest';
import { DIALECTS, mssqlDialect, mysqlDialect, pgDialect } from './dialect.js';

describe('pgDialect', () => {
  it('renders placeholders as $N', () => {
    expect(pgDialect.placeholder(1)).toBe('$1');
    expect(pgDialect.placeholder(42)).toBe('$42');
  });

  it('quotes plain identifiers', () => {
    expect(pgDialect.quoteIdentifier('users')).toBe('"users"');
  });

  it('doubles embedded double quotes', () => {
    expect(pgDialect.quoteIdentifier('a"b')).toBe('"a""b"');
    expect(pgDialect.quoteIdentifier('""')).toBe('""""""');
  });

  it('rejects empty identifiers', () => {
    expect(() => pgDialect.quoteIdentifier('')).toThrow(/empty identifier/);
  });

  it('rejects identifiers containing a null byte', () => {
    expect(() => pgDialect.quoteIdentifier('a\0b')).toThrow(/null byte/);
  });
});

describe('mysqlDialect', () => {
  it('renders all placeholders as ?', () => {
    expect(mysqlDialect.placeholder(1)).toBe('?');
    expect(mysqlDialect.placeholder(99)).toBe('?');
  });

  it('quotes plain identifiers', () => {
    expect(mysqlDialect.quoteIdentifier('users')).toBe('`users`');
  });

  it('doubles embedded backticks', () => {
    expect(mysqlDialect.quoteIdentifier('a`b')).toBe('`a``b`');
  });

  it('rejects empty identifiers', () => {
    expect(() => mysqlDialect.quoteIdentifier('')).toThrow(/empty identifier/);
  });

  it('rejects identifiers containing a null byte', () => {
    expect(() => mysqlDialect.quoteIdentifier('a\0b')).toThrow(/null byte/);
  });
});

describe('mssqlDialect', () => {
  it('renders placeholders as @pN', () => {
    expect(mssqlDialect.placeholder(1)).toBe('@p1');
    expect(mssqlDialect.placeholder(7)).toBe('@p7');
  });

  it('quotes plain identifiers', () => {
    expect(mssqlDialect.quoteIdentifier('users')).toBe('[users]');
  });

  it('doubles embedded closing brackets', () => {
    expect(mssqlDialect.quoteIdentifier('a]b')).toBe('[a]]b]');
  });

  it('rejects empty identifiers', () => {
    expect(() => mssqlDialect.quoteIdentifier('')).toThrow(/empty identifier/);
  });

  it('rejects identifiers containing a null byte', () => {
    expect(() => mssqlDialect.quoteIdentifier('a\0b')).toThrow(/null byte/);
  });
});

describe('DIALECTS lookup', () => {
  it('exposes one entry per DatabaseDriver', () => {
    expect(DIALECTS.pg).toBe(pgDialect);
    expect(DIALECTS.mysql).toBe(mysqlDialect);
    expect(DIALECTS.mssql).toBe(mssqlDialect);
  });
});

describe('identifier injection probes', () => {
  // Classic injection payloads aimed at the identifier-quoting layer.
  // After quoting, each must be a single, well-formed identifier — escape characters
  // doubled, no early termination of the surrounding quote.
  const probes = [
    '"; DROP TABLE users; --',
    "'; DROP TABLE users; --",
    '`; DROP TABLE users; --',
    ']; DROP TABLE users; --',
    'name"with"quotes',
    'tick`tick',
    'square]bracket',
  ];

  const countChar = (s: string, ch: string): number => {
    let n = 0;
    for (const c of s) if (c === ch) n++;
    return n;
  };

  it('pg: every embedded " is doubled', () => {
    for (const p of probes) {
      const quoted = pgDialect.quoteIdentifier(p);
      // outer pair + 2 per embedded "
      expect(countChar(quoted, '"')).toBe(2 + countChar(p, '"') * 2);
      expect(quoted.startsWith('"')).toBe(true);
      expect(quoted.endsWith('"')).toBe(true);
    }
  });

  it('mysql: every embedded ` is doubled', () => {
    for (const p of probes) {
      const quoted = mysqlDialect.quoteIdentifier(p);
      expect(countChar(quoted, '`')).toBe(2 + countChar(p, '`') * 2);
      expect(quoted.startsWith('`')).toBe(true);
      expect(quoted.endsWith('`')).toBe(true);
    }
  });

  it('mssql: every embedded ] is doubled', () => {
    for (const p of probes) {
      const quoted = mssqlDialect.quoteIdentifier(p);
      expect(countChar(quoted, ']')).toBe(1 + countChar(p, ']') * 2);
      expect(quoted.startsWith('[')).toBe(true);
      expect(quoted.endsWith(']')).toBe(true);
    }
  });
});
