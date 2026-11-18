/**
 * Restore drill: restore a backup into a NEW scratch database and verify it, then drop the scratch DB.
 *   node tooling/backup/restore-verify.ts --backup <file.dump> --target-url <admin url of a scratch cluster> [--keep] [--json]
 * Never touches an existing database: the target database name is generated (restore_verify_<time>_<rand>).
 * Checks: checksum + size vs manifest; pg_restore succeeds (single transaction, exit on error); row counts
 * per table equal the manifest; migration ledger identical; no RLS violations; as the app role, no tenant
 * row is visible without a tenant context and, for sampled tenants, only that tenant's rows are visible.
 * Exit 0 = verified, 1 = verification failed.
 */
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { parseArgs, promisify } from 'node:util'
import pg from 'pg'
import { ensureRoles, findRlsViolations, APP_ROLE } from '@platform/tenancy-db'
import { migrationLedger, pgBin, sha256File, tableCounts, type BackupManifest } from './backup.ts'

const run = promisify(execFile)

export interface VerifyCheck { id: string; ok: boolean; details: string[] }
export interface VerifyReport { ok: boolean; database: string; kept: boolean; restoreMs: number; totalMs: number; checks: VerifyCheck[] }

const withDb = (url: string, db: string, user?: string, password?: string) => {
  const u = new URL(url)
  u.pathname = '/' + db
  if (user) {
    u.username = user
    u.password = password ?? ''
  }
  return u.toString()
}

async function client<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    return await fn(c)
  } finally {
    await c.end().catch(() => undefined)
  }
}

export async function restoreVerify(o: {
  backupFile: string
  manifestFile?: string
  /** admin connection to the cluster that receives the scratch database */
  targetAdminUrl: string
  appRole?: string
  appPassword?: string
  keep?: boolean
  sampleTenants?: number
}): Promise<VerifyReport> {
  const t0 = Date.now()
  const checks: VerifyCheck[] = []
  const check = (id: string, problems: string[], info: string[] = []) => checks.push({ id, ok: problems.length === 0, details: problems.length ? problems : info })
  const manifest = JSON.parse(readFileSync(o.manifestFile ?? `${o.backupFile}.manifest.json`, 'utf8')) as BackupManifest
  const database = `restore_verify_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${randomBytes(4).toString('hex')}`
  const done = (restoreMs = 0): VerifyReport => ({ ok: checks.every((c) => c.ok), database, kept: !!o.keep, restoreMs, totalMs: Date.now() - t0, checks })

  // 1. integrity of the artifact itself
  const size = existsSync(o.backupFile) ? statSync(o.backupFile).size : -1
  const sum = size >= 0 ? await sha256File(o.backupFile) : ''
  check('artifact.checksum', [
    ...(size !== manifest.sizeBytes ? [`size ${size} != manifest ${manifest.sizeBytes}`] : []),
    ...(sum !== manifest.sha256 ? ['sha256 does not match the manifest (corrupted or tampered backup)'] : []),
  ], [`sha256 ${sum}`])
  if (!checks[0]!.ok) return done()

  // 2. restore into a fresh database (roles first: grants and policies refer to them)
  await ensureRoles(o.targetAdminUrl)
  await client(o.targetAdminUrl, (c) => c.query(`create database ${database}`))
  const scratchAdmin = withDb(o.targetAdminUrl, database)
  const tr = Date.now()
  let restoreMs = 0
  try {
    try {
      await run(pgBin('pg_restore'), ['--exit-on-error', '--single-transaction', '--no-password', '--dbname', scratchAdmin, o.backupFile], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      restoreMs = Date.now() - tr
      check('restore', [], [`pg_restore ok in ${restoreMs} ms`])
    } catch (e) {
      check('restore', [`pg_restore failed: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).replaceAll(scratchAdmin, '<url>').slice(0, 2000)}`])
      return done()
    }

    // 3. contents match the manifest
    await client(scratchAdmin, async (c) => {
      await c.query('begin isolation level repeatable read read only')
      await c.query('set local row_security = off')
      const counts = await tableCounts(c)
      const p: string[] = []
      for (const [t, n] of Object.entries(manifest.tables)) if (counts[t] !== n) p.push(`${t}: restored ${counts[t] ?? 'missing'} rows, manifest ${n}`)
      for (const t of Object.keys(counts)) if (!(t in manifest.tables)) p.push(`${t}: not in manifest`)
      check('rows.match_manifest', p, [`${Object.keys(counts).length} tables, ${Object.values(counts).reduce((a, b) => a + b, 0)} rows`])
      const ledger = await migrationLedger(c)
      check('migrations.ledger', JSON.stringify(ledger) === JSON.stringify(manifest.migrations) ? [] : ['migration ledger differs from the manifest'], [`${ledger.length} migrations`])
      await c.query('commit')
      const v = await findRlsViolations({ query: async (q, params) => { const r = await c.query(q, params as unknown[]); return { rows: r.rows, rowCount: r.rowCount ?? 0 } } })
      check('rls.policies', v.map((x) => `${x.schema}.${x.table}: ${x.problem}`), ['every tenant table has RLS enabled, forced and a policy'])
    })

    // 4. RLS actually enforced for the runtime role
    const { tenantTables, tenants, expected } = await client(scratchAdmin, async (c) => {
      const tt = (await c.query<{ s: string; t: string }>(`
        select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
        where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') order by 1, 2`)).rows.map((r) => `"${r.s}"."${r.t}"`)
      const ts = (await c.query<{ id: string }>(`select id from platform.tenants order by created_at nulls last, id limit $1`, [o.sampleTenants ?? 3]).catch(() => ({ rows: [] as { id: string }[] }))).rows.map((r) => r.id)
      const exp: Record<string, number> = {}
      await c.query('set row_security = off')
      for (const tid of ts) for (const t of tt) exp[`${tid}|${t}`] = Number((await c.query(`select count(*) as n from ${t} where tenant_id = $1`, [tid])).rows[0].n)
      return { tenantTables: tt, tenants: ts, expected: exp }
    })
    const appRole = o.appRole ?? APP_ROLE
    await client(withDb(o.targetAdminUrl, database, appRole, o.appPassword), async (c) => {
      const p: string[] = []
      const info: string[] = []
      for (const t of tenantTables) {
        const r = await c.query(`select count(*)::int as n from ${t}`).catch((e: Error) => ({ rows: [{ n: -1, err: e.message }] }))
        if (r.rows[0].n > 0) p.push(`${t}: ${r.rows[0].n} rows visible without a tenant context`)
      }
      for (const tid of tenants) {
        let visibleOwn = 0
        let expectedOwn = 0
        await c.query('begin')
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tid])
        for (const t of tenantTables) {
          await c.query('savepoint probe')
          const r = await c.query(`select count(*) filter (where tenant_id <> $1)::int as foreign_rows, count(*) filter (where tenant_id = $1)::int as own from ${t}`, [tid])
            .catch(async () => {
              await c.query('rollback to savepoint probe') // no SELECT grant (e.g. secrets tables) = nothing readable
              return { rows: [{ foreign_rows: 0, own: 0 }] }
            })
          if (r.rows[0].foreign_rows > 0) p.push(`${t}: tenant ${tid} can read ${r.rows[0].foreign_rows} rows of other tenants`)
          visibleOwn += r.rows[0].own
          expectedOwn += expected[`${tid}|${t}`] ?? 0
        }
        await c.query('rollback')
        if (expectedOwn > 0 && visibleOwn === 0) p.push(`tenant ${tid}: none of its ${expectedOwn} rows are readable within its own context`)
        info.push(`tenant ${tid.slice(0, 8)}…: ${visibleOwn}/${expectedOwn} own rows readable, 0 foreign`)
      }
      check('rls.enforced', p, [`${tenantTables.length} tenant tables, ${tenants.length} sampled tenants as ${appRole}`, ...info])
    })
    return done(restoreMs)
  } finally {
    if (!o.keep) await client(o.targetAdminUrl, (c) => c.query(`drop database if exists ${database} with (force)`)).catch(() => undefined)
  }
}

export function formatVerify(r: VerifyReport): string {
  return [
    `Restore verification into ${r.database}${r.kept ? ' (kept)' : ' (dropped)'}`,
    ...r.checks.flatMap((c) => [`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id}`, ...c.details.map((d) => `        ${d}`)]),
    `${r.ok ? 'VERIFIED' : 'FAILED'} (restore ${r.restoreMs} ms, total ${r.totalMs} ms)`,
  ].join('\n')
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { backup: { type: 'string' }, manifest: { type: 'string' }, 'target-url': { type: 'string' }, keep: { type: 'boolean' }, json: { type: 'boolean' } } })
  if (!values.backup || !values['target-url']) {
    console.error('usage: node tooling/backup/restore-verify.ts --backup <file.dump> --target-url <admin url> [--manifest <file>] [--keep] [--json]')
    process.exit(1)
  }
  try {
    const r = await restoreVerify({ backupFile: values.backup, manifestFile: values.manifest, targetAdminUrl: values['target-url'], keep: values.keep, appPassword: process.env.RESTORE_APP_PASSWORD })
    console.log(values.json ? JSON.stringify(r, null, 2) : formatVerify(r))
    process.exitCode = r.ok ? 0 : 1
  } catch (e) {
    console.error(`restore-verify crashed: ${(e as Error).message}`)
    process.exitCode = 2
  }
}
