import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { migrate, createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createTestDatabase, TEST_CLUSTER_URL, type TestDatabase } from '@platform/tenancy-db/testing'
import { createIdentityService, memoryTransport } from '@platform/identity'
import { migrationSetsFor } from '@platform/module-runtime'
import { configureLogging } from '@platform/observability'
import { createBackup, pgBin, type BackupManifest } from '../tooling/backup/backup.ts'
import { restoreVerify, formatVerify } from '../tooling/backup/restore-verify.ts'

// pg_dump/pg_restore must match the server major version (17). Locally they come from PG_BIN or the default
// install path; CI installs postgresql-client-17. Outside CI a missing binary skips instead of failing.
const haveTools = existsSync(pgBin('pg_dump')) && existsSync(pgBin('pg_restore'))
const skip = !haveTools && !process.env.CI ? 'pg_dump/pg_restore 17 not found (set PG_BIN)' : false

let t: TestDatabase
let dir: string

before(async () => {
  if (skip) return
  if (!process.env.TEST_VERBOSE) configureLogging({ level: 'error', sink: () => undefined })
  t = await createTestDatabase('bk')
  await migrate(t.ownerUrl, migrationSetsFor([]))
  const db = createDatabase(t.appUrl)
  const system = createSystemDatabase(t.systemUrl)
  const id = createIdentityService({ system, db, mail: memoryTransport(), publicBaseUrl: 'http://app.test' })
  await id.createTenant({ slug: 'uni-a', name: 'A', adminEmail: 'admin@a.test' })
  await id.createTenant({ slug: 'uni-b', name: 'B', adminEmail: 'admin@b.test' })
  await db.close()
  await system.close()
  dir = mkdtempSync(join(tmpdir(), 'backup-'))
})
after(async () => {
  if (skip) return
  await t.drop()
  rmSync(dir, { recursive: true, force: true })
})

test('backup → restore into a scratch database → verify (counts, ledger, RLS enforced per tenant)', { skip }, async () => {
  const b = await createBackup({ databaseUrl: t.ownerUrl, outDir: dir })
  const m = JSON.parse(readFileSync(b.manifestFile, 'utf8')) as BackupManifest
  assert.equal(m.format, 'ekbharat-backup/v1')
  assert.equal(m.tenants, 2)
  assert.match(m.sha256, /^[0-9a-f]{64}$/)
  assert.ok(m.migrations.length >= 5)
  assert.ok(m.tables['platform.audit_events']! > 0, 'seeded audit rows are counted')
  assert.ok(!readFileSync(b.manifestFile, 'utf8').includes('postgres://'), 'manifest holds no connection URL')

  const r = await restoreVerify({ backupFile: b.file, targetAdminUrl: TEST_CLUSTER_URL })
  assert.equal(r.ok, true, formatVerify(r))
  assert.deepEqual(r.checks.map((c) => c.id), ['artifact.checksum', 'restore', 'rows.match_manifest', 'migrations.ledger', 'rls.policies', 'rls.enforced'])
  assert.match(r.checks.at(-1)!.details.join('\n'), /2 sampled tenants/)
  assert.match(r.checks.at(-1)!.details.join('\n'), /[1-9]\d*\/[1-9]\d* own rows readable, 0 foreign/)
  // the scratch database is dropped afterwards
  const c = new pg.Client({ connectionString: TEST_CLUSTER_URL })
  await c.connect()
  assert.equal((await c.query('select count(*)::int as n from pg_database where datname = $1', [r.database])).rows[0].n, 0)
  await c.end()
})

test('restore-verify rejects a tampered backup and a manifest that does not match the data', { skip }, async () => {
  const b = await createBackup({ databaseUrl: t.ownerUrl, outDir: dir, label: 'tamper' })
  // manifest claims a different row count → restore succeeds but verification fails
  const m = JSON.parse(readFileSync(b.manifestFile, 'utf8')) as BackupManifest
  writeFileSync(`${b.file}.edited.json`, JSON.stringify({ ...m, tables: { ...m.tables, 'platform.tenants': 3 } }))
  const wrong = await restoreVerify({ backupFile: b.file, manifestFile: `${b.file}.edited.json`, targetAdminUrl: TEST_CLUSTER_URL })
  assert.equal(wrong.ok, false)
  assert.match(wrong.checks.find((c) => c.id === 'rows.match_manifest')!.details.join(), /platform\.tenants: restored 2 rows, manifest 3/)
  // flipped bytes → checksum failure, nothing restored
  appendFileSync(b.file, 'x')
  const bad = await restoreVerify({ backupFile: b.file, targetAdminUrl: TEST_CLUSTER_URL })
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.checks.map((c) => c.id), ['artifact.checksum'])
})

test('restore-verify detects a restored database whose RLS was weakened', { skip }, async () => {
  // weaken RLS in the source, back it up, and the drill must catch it
  const c = new pg.Client({ connectionString: t.ownerUrl })
  await c.connect()
  await c.query('alter table platform.audit_events no force row level security')
  await c.query('alter table platform.audit_events disable row level security')
  try {
    const b = await createBackup({ databaseUrl: t.ownerUrl, outDir: dir, label: 'weak' })
    const r = await restoreVerify({ backupFile: b.file, targetAdminUrl: TEST_CLUSTER_URL })
    assert.equal(r.ok, false)
    assert.match(r.checks.find((x) => x.id === 'rls.policies')!.details.join(), /platform\.audit_events: rls_disabled/)
    assert.match(r.checks.find((x) => x.id === 'rls.enforced')!.details.join(), /audit_events.*(without a tenant context|can read)/)
  } finally {
    await c.query('alter table platform.audit_events enable row level security')
    await c.query('alter table platform.audit_events force row level security')
    await c.end()
  }
})
