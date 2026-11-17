import pg from 'pg'
import { AppError, isUuid } from '@platform/core'

export interface QueryResult<T> {
  rows: T[]
  rowCount: number
}
/** Anything that can run SQL: a pool, or a transaction handle. */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>
}

/** Identity of the caller for row-level security. */
export interface TenantContext {
  tenantId: string
  userId?: string
  /** platform role names held in this tenant, e.g. ['student'] */
  roles?: string[]
}

// numeric/bigint come back as strings by default; parse bigint (counts, cost micros) as number
pg.types.setTypeParser(20, (v: string) => Number(v))

function wrap(client: pg.Pool | pg.PoolClient): Sql {
  return {
    async query<T>(text: string, params?: unknown[]) {
      const r = await client.query(text, params as unknown[] | undefined)
      return { rows: r.rows as T[], rowCount: r.rowCount ?? 0 }
    },
  }
}

export interface Database {
  /** Run `fn` in a transaction scoped to one tenant. RLS policies read `app.tenant_id`. */
  withTenant<T>(ctx: TenantContext, fn: (tx: Sql) => Promise<T>): Promise<T>
  /** Run `fn` in a transaction with no tenant set: only non-tenant platform data is visible under RLS. */
  withAnonymous<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  close(): Promise<void>
}

async function inTx<T>(pool: pg.Pool, setup: (c: pg.PoolClient) => Promise<void>, fn: (tx: Sql) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await setup(client)
    const out = await fn(wrap(client))
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}

/**
 * Runtime database for request handling. Connects as the application role, which has no BYPASSRLS
 * and does not own tables, so every tenant table is filtered by RLS.
 */
export function createDatabase(url: string, opts: { max?: number } = {}): Database {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 10 })
  pool.on('error', () => undefined) // idle client errors are surfaced on next use
  return {
    withTenant(ctx, fn) {
      if (!isUuid(ctx.tenantId)) throw new AppError('tenant_context_invalid', 'A valid tenant id is required')
      return inTx(pool, async (c) => {
        await c.query(
          `select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.roles', $3, true)`,
          [ctx.tenantId, ctx.userId ?? '', (ctx.roles ?? []).join(',')],
        )
      }, fn)
    },
    withAnonymous(fn) {
      return inTx(pool, async (c) => { await c.query(`select set_config('app.tenant_id', '', true)`) }, fn)
    },
    close: () => pool.end(),
  }
}
