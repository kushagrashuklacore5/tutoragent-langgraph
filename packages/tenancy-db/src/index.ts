export * from './db.ts'
export * from './migrate.ts'
export * from './rls.ts'
import { fileURLToPath } from 'node:url'
import type { MigrationSet } from './migrate.ts'
/** Base platform schema: tenants + RLS helper functions. Always the first migration set. */
export const baseMigrations: MigrationSet = {
  owner: 'platform.base',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}
