// Replace top-level null values with undefined so consumers can model
// nullable columns with `?:` (which is `T | undefined`) instead of `| null`.
// Shallow only — JSON column values keep their internal nulls intact.
export function nullsToUndefined<R>(row: R): R {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return row;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    row as Record<string, unknown>,
  )) {
    result[key] = value === null ? undefined : value;
  }
  return result as R;
}
