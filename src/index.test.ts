import { describe, expect, it } from 'vitest';
import { VERSION, createDatabase } from './index.js';

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

  it('driver.close is a no-op when no real driver was loaded', async () => {
    const db = createDatabase({
      driver: 'pg',
      connectionString: 'postgres://x',
    });
    await expect(db.driver.close()).resolves.toBeUndefined();
  });
});
