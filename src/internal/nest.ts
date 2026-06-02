import type { AnyJoin } from '../core/dbCore.js';

// `any` mirrors the use in sql.ts — joins are walked structurally at runtime;
// L/R/A type parameters aren't needed past the public type surface. See
// dbCore.ts for the rationale (DbCore<T> is invariant in T, so `unknown`
// doesn't substitute for `any` here).
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyJoinInput = AnyJoin<any>;
type JoinsInput = AnyJoinInput | readonly AnyJoinInput[];
/* eslint-enable @typescript-eslint/no-explicit-any */

function normalizeJoins(j: JoinsInput | undefined): readonly AnyJoinInput[] {
  if (!j) return [];
  return Array.isArray(j)
    ? (j as readonly AnyJoinInput[])
    : [j as AnyJoinInput];
}

// A nested join slot is "absent" when every leaf value beneath it came back
// undefined — that's how the result mapper detects a LEFT/FULL no-match.
// Nulls are normalized to undefined at the driver layer (see normalize.ts),
// so this single check covers both cases.
function isAllUndefined(slot: unknown): boolean {
  if (slot === undefined) return true;
  if (slot === null || typeof slot !== 'object' || Array.isArray(slot)) {
    return false;
  }
  for (const value of Object.values(slot as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!isAllUndefined(value)) return false;
  }
  return true;
}

// Walk a flat row with dotted keys (`o.total`, `o.it.sku`) into a nested
// object keyed by alias at each level. The recursion uses a growing path
// prefix so the same flat row can feed every depth.
function nestAtPath(
  row: Record<string, unknown>,
  pathPrefix: string,
  joins: readonly AnyJoinInput[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const stripLen = pathPrefix.length;

  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith(pathPrefix)) continue;
    const tail = key.slice(stripLen);
    if (tail.length === 0 || tail.includes('.')) continue;
    result[tail] = value;
  }

  for (const join of joins) {
    const childPath = `${pathPrefix}${join.alias}.`;
    const childJoins = normalizeJoins(join.select?.join);
    const childRow = nestAtPath(row, childPath, childJoins);

    const isOptional = join.type === 'left' || join.type === 'full';
    result[join.alias] =
      isOptional && isAllUndefined(childRow) ? undefined : childRow;
  }

  return result;
}

export function nestJoinedRow(
  row: Record<string, unknown>,
  joins: JoinsInput | undefined,
): Record<string, unknown> {
  const list = normalizeJoins(joins);
  if (list.length === 0) return row;
  return nestAtPath(row, '', list);
}

// Recursive guard — every join used by select() must carry its column list
// so the SQL builder can alias-prefix projections and the nester knows
// which keys to consume per level. count() skips this check since its
// COUNT(*) doesn't project.
export function assertJoinColumns(joins: JoinsInput | undefined): void {
  const list = normalizeJoins(joins);
  for (const join of list) {
    const cols = join.select?.columns;
    if (!cols || cols.length === 0) {
      throw new TypeError(
        `altacore: select() with join requires 'select.columns' on every ` +
          `join. Missing or empty columns on alias "${join.alias}".`,
      );
    }
    if (join.select?.join) assertJoinColumns(join.select.join);
  }
}
