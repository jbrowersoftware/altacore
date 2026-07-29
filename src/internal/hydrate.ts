import type { DbCore } from '../core/dbCore.js';

// `any` mirrors sql.ts/nest.ts — hydration relations are walked structurally
// at runtime, and DbCore is invariant in its parameters so `unknown` doesn't
// substitute. See dbCore.ts for the rationale.
/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyDbCore = DbCore<any, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

// Runtime (untyped-key) mirror of the public HydrationSpec<T, H>. `table` may
// be a thunk so self-referential and mutually-referential cores can be wired
// regardless of declaration order.
export type HydrationRelationRuntime = {
  table: AnyDbCore | (() => AnyDbCore);
  on: readonly [string, string];
};

export type HydrationSpecRuntime = Readonly<
  Record<string, HydrationRelationRuntime>
>;

export type ResolvedHydration = {
  key: string;
  table: AnyDbCore;
  fkCol: string;
  refCol: string;
};

// Validate the requested hydrate keys against the spec and the call's column
// projection, resolving table thunks. Runs BEFORE the main query so a bad key
// or a projected-away FK fails without a round-trip. Duplicate keys collapse
// to their first occurrence.
export function resolveHydration(
  table: string,
  keys: readonly string[] | undefined,
  spec: HydrationSpecRuntime | undefined,
  columns: readonly string[] | undefined,
): ResolvedHydration[] {
  if (!keys || keys.length === 0) return [];
  const resolved: ResolvedHydration[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = spec?.[key];
    if (!rel) {
      throw new TypeError(
        `altacore: hydrate key "${key}" has no relation configured for ` +
          `table "${table}". Declare it in createDbCore's 'hydration' option.`,
      );
    }
    const [fkCol, refCol] = rel.on;
    if (columns && !columns.includes(fkCol)) {
      throw new TypeError(
        `altacore: hydrate key "${key}" reads FK column "${fkCol}", which ` +
          `is not in 'columns'. Include it in the projection.`,
      );
    }
    resolved.push({
      key,
      table: typeof rel.table === 'function' ? rel.table() : rel.table,
      fkCol,
      refCol,
    });
  }
  return resolved;
}

// Graft related records onto rows in place: one batched lookup per relation
// (`WHERE <refCol> IN (<distinct non-null FK values>)`), all relations in
// parallel. Rows with a NULL/absent FK, or an FK with no match, are left
// without the key. Rows sharing an FK value share the same related object.
export async function hydrateRows(
  rows: Array<Record<string, unknown>>,
  relations: readonly ResolvedHydration[],
): Promise<void> {
  if (rows.length === 0 || relations.length === 0) return;

  // Hydration keys land as new row properties; an existing property (column
  // or join alias) of the same name would be silently clobbered — refuse.
  const first = rows[0] as Record<string, unknown>;
  for (const rel of relations) {
    if (rel.key in first) {
      throw new TypeError(
        `altacore: hydrate key "${rel.key}" collides with an existing ` +
          `property of the same name on the result row.`,
      );
    }
  }

  await Promise.all(
    relations.map(async (rel) => {
      const values = new Set<unknown>();
      for (const row of rows) {
        const v = row[rel.fkCol];
        if (v !== undefined && v !== null) values.add(v);
      }
      if (values.size === 0) return;

      const related = (await rel.table.select({
        where: { [rel.refCol]: { in: [...values] } },
      })) as Array<Record<string, unknown>>;

      const byRef = new Map<unknown, Record<string, unknown>>();
      for (const r of related) byRef.set(r[rel.refCol], r);

      for (const row of rows) {
        const v = row[rel.fkCol];
        if (v === undefined || v === null) continue;
        const match = byRef.get(v);
        if (match !== undefined) row[rel.key] = match;
      }
    }),
  );
}
