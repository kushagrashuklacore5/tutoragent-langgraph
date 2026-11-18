/**
 * Logical backup of the platform database: `pg_dump` custom format, taken from an exported snapshot so
 * the manifest's row counts and migration ledger describe exactly what is in the dump.
 *   node tooling/backup/backup.ts --out ./backups [--database-url <owner url>]   (default DATABASE_URL)
 * Writes <out>/<db>-<timestamp>.dump and <same>.manifest.json (sha256, size, per-table row counts,
 * migration ledger, server/pg_dump versions). The role must bypass RLS (owner with BYPASSRLS or superuser):
 * tenant tables use FORCE ROW LEVEL SECURITY, and pg_dump refuses to dump a filtered table.
 * This complements, not replaces, cloud-managed PITR backups (F12) — see deploy/RUNBOOK.md.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)
export const pgBin = (name: string, bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '/usr/lib/postgresql/17/bin')) =>
  join(bin, process.platform === 'win32' ? `${name}.exe` : name)

export interface BackupManifest {
  format: 'ekbharat-backup/v1'
  createdAt: string
  database: string
  host: string
  file: string
  sizeBytes: number
  sha256: string
  serverVersion: string
  pgDumpVersion: string
  tables: Record<string, number>
  migrations: { owner: string; name: string; checksum: string }[]
  tenants: number
}

export function sha256File(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256')
    createReadStream(path).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')))
  })
}

/** pg_dump/pg_restore accept a URL; never echo it (it may contain a password). */
export const safeUrl = (url: string) => {
  const u = new URL(url)
  return { host: u.host, database: decodeURIComponent(u.pathname.slice(1)) }
}

/** Row counts of every user table, inside the caller's (snapshot) transaction. */
export async function tableCounts(c: pg.Client): Promise<Record<string, number>> {
  const t = await c.query<{ s: string; t: string }>(`
    select n.nspname as s, c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
      and not c.relispartition
    order by 1, 2`)
  const out: Record<string, number> = {}
  for (const { s, t: name } of t.rows) {
    out[`${s}.${name}`] = Number((await c.query(`select count(*)::bigint as n from "${s.replace(/"/g, '""')}"."${name.replace(/"/g, '""')}"`)).rows[0].n)
  }
  return out
}

export async function migrationLedger(c: pg.Client): Promise<BackupManifest['migrations']> {
  if (!(await c.query(`select to_regclass('public.schema_migrations') is not null as ok`)).rows[0].ok) return []
  return (await c.query('select owner, name, checksum from public.schema_migrations order by owner, name')).rows
}

export async function createBackup(o: { databaseUrl: string; outDir: string; label?: string }): Promise<{ file: string; manifestFile: string; manifest: BackupManifest }> {
  const { host, database } = safeUrl(o.databaseUrl)
  mkdirSync(o.outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const file = resolve(o.outDir, `${o.label ?? database}-${stamp}.dump`)
  const c = new pg.Client({ connectionString: o.databaseUrl })
  await c.connect()
  try {
    await c.query('begin isolation level repeatable read read only')
    // fail loudly instead of silently counting a filtered view of a tenant table
    await c.query('set local row_security = off')
    const snapshot = (await c.query('select pg_export_snapshot() as s')).rows[0].s as string
    const tables = await tableCounts(c)
    const migrations = await migrationLedger(c)
    const tenants = tables['platform.tenants'] ?? 0
    const serverVersion = (await c.query('show server_version')).rows[0].server_version as string
    const pgDumpVersion = (await run(pgBin('pg_dump'), ['--version'])).stdout.trim()
    // the dump runs while our transaction holds the snapshot open
    await run(pgBin('pg_dump'), ['--format=custom', '--compress=6', `--snapshot=${snapshot}`, '--no-password', '--file', file, '--dbname', o.databaseUrl], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      .catch((e: { stderr?: string }) => { throw new Error(`pg_dump failed: ${(e.stderr ?? '').replaceAll(o.databaseUrl, '<url>').trim()}`) })
    await c.query('commit')
    const manifest: BackupManifest = {
      format: 'ekbharat-backup/v1', createdAt: new Date().toISOString(), database, host, file: basename(file),
      sizeBytes: statSync(file).size, sha256: await sha256File(file), serverVersion, pgDumpVersion, tables, migrations, tenants,
    }
    const manifestFile = `${file}.manifest.json`
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
    return { file, manifestFile, manifest }
  } catch (e) {
    await c.query('rollback').catch(() => undefined)
    throw e
  } finally {
    await c.end()
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, 'database-url': { type: 'string' }, label: { type: 'string' } } })
  const url = values['database-url'] ?? process.env.DATABASE_URL
  if (!url || !values.out) {
    console.error('usage: node tooling/backup/backup.ts --out <dir> [--database-url <owner url>] [--label <name>]')
    process.exit(1)
  }
  try {
    const r = await createBackup({ databaseUrl: url, outDir: values.out, label: values.label })
    console.log(JSON.stringify({ file: r.file, manifest: r.manifestFile, sha256: r.manifest.sha256, sizeBytes: r.manifest.sizeBytes, tables: Object.keys(r.manifest.tables).length, tenants: r.manifest.tenants }, null, 2))
  } catch (e) {
    console.error((e as Error).message)
    process.exit(1)
  }
}
