import pg from 'pg'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, sha256 } from '@platform/core'
import { logger } from '@platform/observability'

/** A named set of migrations owned by a package or module, applied to exactly one schema. */
export interface MigrationSet {
  /** ledger key, e.g. `platform.identity` or `education.tutor` */
  owner: string
  /** schema the set creates and is allowed to touch */
  schema: string
  /** folder with `NNNN_name.sql` files */
  dir: string
}

export const APP_ROLE = 'platform_app'
export const SYSTEM_ROLE = 'platform_system'

const LOCK_ID = 727_001

/** Create the cluster roles used at runtime (idempotent). Passwords are optional for trust-auth dev clusters. */
export async function ensureRoles(ownerUrl: string, passwords: { app?: string; system?: string } = {}): Promise<void> {
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  try {
    for (const [role, extra, pw] of [
      [APP_ROLE, 'NOBYPASSRLS', passwords.app],
      [SYSTEM_ROLE, 'BYPASSRLS', passwords.system],
    ] as const) {
      const exists = await c.query('select 1 from pg_roles where rolname = $1', [role])
      if (!exists.rowCount) {
        try {
          await c.query(`create role ${role} login ${extra}${pw ? ` password '${pw.replace(/'/g, "''")}'` : ''}`)
        } catch (e) {
          // another process may have created it concurrently
          if ((e as { code?: string }).code !== '42710') throw e
        }
      }
    }
  } finally {
    await c.end()
  }
}

/**
 * Apply pending migrations in order. Each file runs in its own transaction, recorded in
 * `public.schema_migrations`. A changed checksum of an applied file is an error (never edit applied migrations).
 * New tables get default privileges for the runtime roles; migrations may REVOKE (e.g. append-only audit).
 */
export async function migrate(ownerUrl: string, sets: MigrationSet[]): Promise<{ applied: string[] }> {
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  const applied: string[] = []
  try {
    await c.query('select pg_advisory_lock($1)', [LOCK_ID])
    await c.query(`create table if not exists public.schema_migrations (
      owner text not null, name text not null, checksum text not null, applied_at timestamptz not null default now(),
      primary key (owner, name))`)
    for (const set of sets) {
      if (!/^[a-z][a-z0-9_]*$/.test(set.schema)) throw new AppError('migration_invalid', `Invalid schema name ${set.schema}`)
      await c.query(`create schema if not exists ${set.schema}`)
      await c.query(`grant usage on schema ${set.schema} to ${APP_ROLE}, ${SYSTEM_ROLE}`)
      await c.query(`alter default privileges in schema ${set.schema} grant select, insert, update, delete on tables to ${APP_ROLE}, ${SYSTEM_ROLE}`)
      await c.query(`alter default privileges in schema ${set.schema} grant usage, select on sequences to ${APP_ROLE}, ${SYSTEM_ROLE}`)
      await c.query(`alter default privileges in schema ${set.schema} grant execute on functions to ${APP_ROLE}, ${SYSTEM_ROLE}`)
      if (!existsSync(set.dir)) continue
      const files = readdirSync(set.dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
      const done = new Map(
        (await c.query('select name, checksum from public.schema_migrations where owner = $1', [set.owner])).rows.map((r) => [r.name as string, r.checksum as string]),
      )
      for (const f of files) {
        const sql = readFileSync(join(set.dir, f), 'utf8')
        const sum = sha256(sql)
        const prev = done.get(f)
        if (prev) {
          if (prev !== sum) throw new AppError('migration_checksum_mismatch', `${set.owner}/${f} changed after it was applied`)
          continue
        }
        await c.query('BEGIN')
        try {
          await c.query(`set local search_path to ${set.schema}, public`)
          await c.query(sql)
          await c.query('insert into public.schema_migrations (owner, name, checksum) values ($1, $2, $3)', [set.owner, f, sum])
          await c.query('COMMIT')
        } catch (e) {
          await c.query('ROLLBACK')
          throw new AppError('migration_failed', `${set.owner}/${f}: ${(e as Error).message}`, { cause: e })
        }
        applied.push(`${set.owner}/${f}`)
        logger.info('migration applied', { owner: set.owner, file: f })
      }
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined)
    await c.end()
  }
  return { applied }
}

/** Drop a module schema and its ledger entries. Used only by the explicit module purge command. */
export async function dropMigrationSet(ownerUrl: string, set: Pick<MigrationSet, 'owner' | 'schema'>): Promise<void> {
  const c = new pg.Client({ connectionString: ownerUrl })
  await c.connect()
  try {
    await c.query('BEGIN')
    await c.query(`drop schema if exists ${set.schema} cascade`)
    await c.query('delete from public.schema_migrations where owner = $1', [set.owner])
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  } finally {
    await c.end()
  }
}
