import { createDatabase, migrate, baseMigrations, type Database, type MigrationSet } from '@platform/tenancy-db'
import { createSystemDatabase, type SystemDatabase } from '@platform/tenancy-db/system'
import { createTestDatabase, type TestDatabase } from '@platform/tenancy-db/testing'
import { identityMigrations } from '@platform/identity'
import { auditMigrations } from '@platform/audit'
import { jobsMigrations } from '@platform/jobs'
import { configureLogging } from '@platform/observability'

/** Platform migration sets in dependency order (gateway and modules append theirs). */
export const corePlatformMigrations: MigrationSet[] = [baseMigrations, identityMigrations, auditMigrations, jobsMigrations]

export interface PlatformTestDb {
  test: TestDatabase
  db: Database
  system: SystemDatabase
  close(): Promise<void>
}

/** Fresh database with platform migrations (+ extra sets) applied; connections as app and system roles. */
export async function setupTestDb(extra: MigrationSet[] = []): Promise<PlatformTestDb> {
  if (!process.env.TEST_VERBOSE) configureLogging({ level: 'error', sink: () => undefined })
  const test = await createTestDatabase()
  await migrate(test.ownerUrl, [...corePlatformMigrations, ...extra])
  const db = createDatabase(test.appUrl, { max: 5 })
  const system = createSystemDatabase(test.systemUrl, { max: 5 })
  return {
    test,
    db,
    system,
    async close() {
      await db.close()
      await system.close()
      await test.drop()
    },
  }
}
