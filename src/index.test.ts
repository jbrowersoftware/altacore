import { describe, expect, it } from 'vitest';
import { VERSION, createDatabase, createDbCore } from './index.js';

describe('altacore', () => {
  it('exports a version string', () => {
    expect(typeof VERSION).toBe('string');
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('createDatabase returns a Database with a synchronous driver proxy', () => {
    const db = createDatabase({
      driver: 'pg',
      connectionString: 'postgres://localhost/test',
    });
    // kind + dialect available immediately, no async required
    expect(db.driver.kind).toBe('pg');
    expect(db.driver.dialect.placeholder(1)).toBe('$1');
    expect(db.driver.dialect.quoteIdentifier('users')).toBe('"users"');
  });

  it('driver.query rejects with a clear error before a backend is wired', async () => {
    const db = createDatabase({
      driver: 'pg',
      connectionString: 'postgres://x',
    });
    await expect(db.driver.query('SELECT 1', [])).rejects.toThrow(
      /pg driver is not yet implemented/,
    );
  });

  it('driver.close is a no-op when no real driver was loaded', async () => {
    const db = createDatabase({
      driver: 'pg',
      connectionString: 'postgres://x',
    });
    await expect(db.driver.close()).resolves.toBeUndefined();
  });

  it('createDbCore returns a typed core whose methods reject until implemented', async () => {
    type Thing = { id: number; name: string };
    const db = createDatabase({ driver: 'pg', connectionString: 'postgres://x' });
    const things = createDbCore<Thing>(db, 'things');
    await expect(things.select({ where: { id: 1 } })).rejects.toThrow(/not yet implemented/);
  });

  it('where clause accepts equality and operator forms', async () => {
    type Thing = { id: number; name: string; age: number };
    const db = createDatabase({ driver: 'pg', connectionString: 'postgres://x' });
    const things = createDbCore<Thing>(db, 'things');

    // Equality form: bare value means `=`
    await expect(things.select({ where: { id: 1 } })).rejects.toThrow();

    // Operator form: object with operator keys
    await expect(
      things.select({
        where: {
          age: { gt: 18, lte: 65 },
          name: { like: 'a%' },
          id: { in: [1, 2, 3] },
        },
      }),
    ).rejects.toThrow();

    // Mixed in the same query
    await expect(
      things.select({ where: { id: 1, age: { gt: 18 } } }),
    ).rejects.toThrow();
  });
});
