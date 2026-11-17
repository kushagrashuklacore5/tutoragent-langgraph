import pg from 'pg'
import { randomBytes } from 'node:crypto'
import { ensureRoles, APP_ROLE, SYSTEM_ROLE } from './migrate.ts'

/** Base URL of the local test cluster (see tooling/dev-db.ts). */
export const TEST_CLUSTER_URL = process.env.TEST_DATABASE_URL ?? 'postgres://platform_owner@127.0.0.1:54329/postgres'

export interface TestDatabase {
  name: string
  ownerUrl: string
  appUrl: string
  systemUrl: string
  drop(): Promise<void>
}

function withDb(url: string, db: string, user?: string): string {
  const u = new URL(url)
  u.pathname = '/' + db
  if (user) {
    u.username = user
    u.password = ''
  }
  return u.toString()
}

/** Create an empty, uniquely named database for one test file. */
export async function createTestDatabase(prefix = 't'): Promise<TestDatabase> {
  await ensureRoles(TEST_CLUSTER_URL)
  const name = `${prefix}_${randomBytes(6).toString('hex')}`
  const admin = new pg.Client({ connectionString: TEST_CLUSTER_URL })
  await admin.connect()
  await admin.query(`create database ${name}`)
  await admin.end()
  return {
    name,
    ownerUrl: withDb(TEST_CLUSTER_URL, name),
    appUrl: withDb(TEST_CLUSTER_URL, name, APP_ROLE),
    systemUrl: withDb(TEST_CLUSTER_URL, name, SYSTEM_ROLE),
    async drop() {
      const a = new pg.Client({ connectionString: TEST_CLUSTER_URL })
      await a.connect()
      await a.query(`drop database if exists ${name} with (force)`)
      await a.end()
    },
  }
}
