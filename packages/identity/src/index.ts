export * from './permissions.ts'
export * from './mail.ts'
export * from './service.ts'
export * from './secrets.ts'
export * from './oidc.ts'
export * from './sso.ts'
export * from './mail-transports.ts'
import { fileURLToPath } from 'node:url'
import type { MigrationSet } from '@platform/tenancy-db'
export const identityMigrations: MigrationSet = {
  owner: 'platform.identity',
  schema: 'platform',
  dir: fileURLToPath(new URL('../migrations', import.meta.url)),
}
