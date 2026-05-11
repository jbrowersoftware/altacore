# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository

Altacore is a Node.js ORM, distributed as a library on npm.

## Code style

- **Functional over class-based.** Prefer pure functions, factory functions, and plain data records over classes. Use closures for encapsulation when state must be carried. Avoid `this`, `new`, and inheritance in the public surface — consumers should call functions, not instantiate objects.
- Author in ESM TypeScript; ship dual ESM/CJS via tsup.
- `verbatimModuleSyntax` is on — use `import type` for type-only imports.
- Colocate tests as `*.test.ts` next to the file under test.

## Layout

Source is grouped by concern under `src/`. Folders emerge as their first real file lands:

- `src/index.ts` — public API barrel; re-export only what consumers should see
- `src/core/` — connection lifecycle, the top-level client factory
- `src/query/` — query building and execution
- `src/schema/` — table/column/model definitions
- `src/drivers/` — per-backend adapters (one file per backend: `pg.ts`, `mysql.ts`, `sqlite.ts`)
- `src/internal/` — private helpers; never re-exported from `index.ts`

Anything not re-exported from `src/index.ts` is implicitly private and may change without a major version bump.

## Build & test

- `npm run build` — tsup → `dist/` (esm + cjs + `.d.ts`)
- `npm test` — vitest
- `npm run typecheck` — `tsc --noEmit`
- `npm run lint` — eslint flat config (type-aware on `src/**`, syntax-only elsewhere)
