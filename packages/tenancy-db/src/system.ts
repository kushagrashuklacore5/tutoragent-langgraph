import pg from 'pg'
import type { Sql } from './db.ts'

/**
 * PRIVILEGED database access (role with BYPASSRLS). Only for operations that are cross-tenant by
 * nature: sign-in before a tenant is known, the job claimer, gateway platform-scope config,
 * migrations and module purge. Import path `@platform/tenancy-db/system` is restricted by the
 * boundary checker to identity, jobs, events, ai-gateway, audit and apps — never modules.
 */
export interface SystemDatabase {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>
  tx<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}

export function createSystemDatabase(url: string, opts: { max?: number } = {}): SystemDatabase {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 5 })
  pool.on('error', () => undefined)
  const wrap = (c: pg.Pool | pg.PoolClient): Sql => ({
    async query<T>(text: string, params?: unknown[]) {
      const r = await c.query(text, params as unknown[] | undefined)
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
    },
  })
  return {
    query: (t, p) => wrap(pool).query(t, p),
    async tx(fn) {
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        const out = await fn(wrap(c))
        await c.query('COMMIT')
        return out
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined)
        throw e
      } finally {
        c.release()
      }
    },
    close: () => pool.end(),
  }
}
