import { fileURLToPath } from 'node:url'
import type { MigrationSet } from '@platform/tenancy-db'

export * from './validate.ts'
export * from './parse.ts'
export * from './storage.ts'
export * from './service.ts'

export const documentsMigrations: MigrationSet = {
  owner: 'platform.documents',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}
