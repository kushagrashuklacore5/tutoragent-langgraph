export * from './queue.ts'
export * from './worker.ts'
export * from './scheduler.ts'
import { fileURLToPath } from 'node:url'
import type { MigrationSet } from '@platform/tenancy-db'
export const jobsMigrations: MigrationSet = {
  owner: 'platform.jobs',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}
