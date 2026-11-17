import { AppError, newId } from '@platform/core'
import type { Sql } from '@platform/tenancy-db'

export interface EnqueueOptions {
  /** dedupe: a second enqueue with the same (type, key) returns the existing job */
  idempotencyKey?: string
  runAt?: Date
  maxAttempts?: number
}

const TYPE = /^[a-z][a-z0-9_.-]*\/[a-z][a-z0-9_.:-]*$/

/**
 * Enqueue a job in the caller's transaction (transactional enqueue: the job exists only if the
 * business change commits). In a tenant transaction the job belongs to that tenant (RLS check).
 * Job types are namespaced `<owner>/<name>`, e.g. `education.tutor/plan.rebuild`.
 */
export async function enqueue(tx: Sql, type: string, payload: unknown, opts: EnqueueOptions = {}): Promise<{ id: string; created: boolean }> {
  if (!TYPE.test(type)) throw new AppError('job_type_invalid', `Job type ${type} must be <owner>/<name>`)
  const id = newId()
  const r = await tx.query<{ id: string }>(
    `insert into platform.jobs (id, tenant_id, type, payload, run_at, max_attempts, idempotency_key)
     values ($1, platform.current_tenant(), $2, $3, coalesce($4, now()), $5, $6)
     on conflict (type, idempotency_key) where idempotency_key is not null do nothing
     returning id`,
    [id, type, JSON.stringify(payload ?? {}), opts.runAt ?? null, opts.maxAttempts ?? 5, opts.idempotencyKey ?? null],
  )
  if (r.rows[0]) return { id: r.rows[0].id, created: true }
  const existing = await tx.query<{ id: string }>('select id from platform.jobs where type = $1 and idempotency_key = $2', [type, opts.idempotencyKey])
  if (!existing.rows[0]) throw new AppError('job_conflict', 'Idempotent job exists in another tenant')
  return { id: existing.rows[0].id, created: false }
}

/** Platform-level (tenant-less) enqueue, for system code paths. */
export async function enqueueSystem(tx: Sql, type: string, payload: unknown, opts: EnqueueOptions & { tenantId?: string | null } = {}) {
  if (!TYPE.test(type)) throw new AppError('job_type_invalid', `Job type ${type} must be <owner>/<name>`)
  const r = await tx.query<{ id: string }>(
    `insert into platform.jobs (id, tenant_id, type, payload, run_at, max_attempts, idempotency_key)
     values ($1, $2, $3, $4, coalesce($5, now()), $6, $7)
     on conflict (type, idempotency_key) where idempotency_key is not null do nothing returning id`,
    [newId(), opts.tenantId ?? null, type, JSON.stringify(payload ?? {}), opts.runAt ?? null, opts.maxAttempts ?? 5, opts.idempotencyKey ?? null],
  )
  return { id: r.rows[0]?.id ?? null, created: !!r.rows[0] }
}
