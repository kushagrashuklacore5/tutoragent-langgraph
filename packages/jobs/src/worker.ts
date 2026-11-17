import { hostname } from 'node:os'
import { randomBytes } from 'node:crypto'
import { captureError, counter, histogram, logger, withSpan } from '@platform/observability'
import type { Database, Sql } from '@platform/tenancy-db'
import type { SystemDatabase } from '@platform/tenancy-db/system'

export interface JobRow {
  id: string
  tenant_id: string | null
  type: string
  payload: unknown
  attempts: number
  max_attempts: number
}

export interface JobContext {
  job: JobRow
  /** run `fn` inside the job tenant's RLS transaction (throws for tenant-less jobs) */
  inTenant<T>(fn: (tx: Sql) => Promise<T>): Promise<T>
  /**
   * Perform a side effect at most once per job, even across crash/retry. The effect key is recorded
   * in the same transaction as `fn`'s writes.
   */
  once<T>(effectKey: string, fn: (tx: Sql) => Promise<T>): Promise<T | undefined>
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>

/** Thrown by handlers for failures that must not be retried (bad payload, missing entity). */
export class PermanentJobError extends Error {
  override name = 'PermanentJobError'
}

export interface WorkerOptions {
  system: SystemDatabase
  db: Database
  handlers: Map<string, JobHandler>
  workerId?: string
  leaseMs?: number
  pollMs?: number
  batch?: number
  backoffBaseMs?: number
}

export function createWorker(o: WorkerOptions) {
  const workerId = o.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`
  const leaseMs = o.leaseMs ?? 60_000
  const backoff = o.backoffBaseMs ?? 2_000
  let running = false
  let timer: NodeJS.Timeout | undefined

  async function claim(limit: number): Promise<JobRow[]> {
    // reclaims expired leases (crashed workers) as well as due queued jobs
    const r = await o.system.query<JobRow>(
      `update platform.jobs set status = 'running', attempts = attempts + 1, locked_by = $1,
              locked_until = now() + ($2::int * interval '1 millisecond'), updated_at = now()
       where id in (
         select id from platform.jobs
         where (status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now())
         order by run_at limit $3 for update skip locked)
       returning id, tenant_id, type, payload, attempts, max_attempts`,
      [workerId, leaseMs, limit],
    )
    return r.rows
  }

  async function finish(job: JobRow, status: 'succeeded' | 'dead', fields: { result?: unknown; error?: string }) {
    await o.system.query(
      `update platform.jobs set status = $2, result = $3, last_error = $4, locked_by = null, locked_until = null,
              finished_at = now(), updated_at = now() where id = $1 and locked_by = $5`,
      [job.id, status, fields.result === undefined ? null : JSON.stringify(fields.result), fields.error ?? null, workerId],
    )
  }

  async function retryLater(job: JobRow, error: string) {
    const delay = Math.min(backoff * 2 ** (job.attempts - 1), 15 * 60_000) * (0.8 + Math.random() * 0.4)
    await o.system.query(
      `update platform.jobs set status = 'queued', run_at = now() + ($2::int * interval '1 millisecond'), last_error = $3,
              locked_by = null, locked_until = null, updated_at = now() where id = $1 and locked_by = $4`,
      [job.id, Math.round(delay), error, workerId],
    )
  }

  function contextFor(job: JobRow): JobContext {
    const inTenant = <T>(fn: (tx: Sql) => Promise<T>) => {
      if (!job.tenant_id) throw new PermanentJobError('job has no tenant')
      return o.db.withTenant({ tenantId: job.tenant_id }, fn)
    }
    return {
      job,
      inTenant,
      async once(effectKey, fn) {
        const run = async (tx: Sql) => {
          const ins = await tx.query('insert into platform.job_effects (job_id, effect_key) values ($1, $2) on conflict do nothing returning job_id', [job.id, effectKey])
          if (!ins.rowCount) return undefined
          return fn(tx)
        }
        return job.tenant_id ? inTenant(run) : o.system.tx(run)
      },
    }
  }

  async function runOne(job: JobRow): Promise<void> {
    const handler = o.handlers.get(job.type)
    const started = performance.now()
    if (!handler) {
      // e.g. a removed or disabled module: dead-letter with a clear reason, keep the worker healthy
      await finish(job, 'dead', { error: `no_handler: ${job.type}` })
      counter('jobs_total', { type: job.type, outcome: 'no_handler' }).inc()
      return
    }
    try {
      const result = await withSpan(`job ${job.type}`, () => handler(contextFor(job)))
      await finish(job, 'succeeded', { result: result ?? null })
      counter('jobs_total', { type: job.type, outcome: 'succeeded' }).inc()
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      const permanent = err instanceof PermanentJobError
      if (permanent || job.attempts >= job.max_attempts) {
        await finish(job, 'dead', { error: msg })
        counter('jobs_total', { type: job.type, outcome: 'dead' }).inc()
        captureError(err, { jobId: job.id, jobType: job.type, attempts: job.attempts })
      } else {
        await retryLater(job, msg)
        counter('jobs_total', { type: job.type, outcome: 'retry' }).inc()
        logger.warn('job failed, will retry', { jobId: job.id, jobType: job.type, attempts: job.attempts, error: msg })
      }
    } finally {
      histogram('job_duration_ms', { type: job.type }).observe(performance.now() - started)
    }
  }

  /** Process up to `batch` due jobs once. Returns how many were processed (used by tests and the loop). */
  async function tick(): Promise<number> {
    const jobs = await claim(o.batch ?? 5)
    await Promise.all(jobs.map(runOne))
    return jobs.length
  }

  return {
    workerId,
    tick,
    /** Drain until no job is due (tests). */
    async drain(maxRounds = 50): Promise<number> {
      let total = 0
      for (let i = 0; i < maxRounds; i++) {
        const n = await tick()
        total += n
        if (!n) break
      }
      return total
    },
    start() {
      if (running) return
      running = true
      const loop = async () => {
        if (!running) return
        let n = 0
        try {
          n = await tick()
        } catch (e) {
          captureError(e, { where: 'worker.tick' })
        }
        timer = setTimeout(loop, n ? 0 : (o.pollMs ?? 1000))
      }
      void loop()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
    },
  }
}
