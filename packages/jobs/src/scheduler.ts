import { AppError } from '@platform/core'
import { captureError, counter, logger } from '@platform/observability'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { enqueueSystem } from './queue.ts'

/**
 * Recurring jobs. A scheduler tick computes the current period of every schedule and enqueues one job
 * per period (per tenant for fan-out schedules) with the idempotency key `schedule:<name>:<period>[:<tenant>]`.
 * The unique (type, idempotency_key) index makes this exactly-once per period no matter how many
 * workers tick concurrently or how often; each process also remembers the last period it completed so
 * steady-state ticks do no database work.
 */

/** `everyMs`: fixed interval aligned to the Unix epoch. `dailyAtUtc`: "HH:MM" once per UTC day. */
export type ScheduleSpec = { everyMs: number } | { dailyAtUtc: string }

export interface ScheduleDef {
  /** unique schedule name, e.g. `education.tutor/delayed-checks` */
  name: string
  /** job type to enqueue, e.g. `education.tutor/delayed_checks.fanout` */
  jobType: string
  spec: ScheduleSpec
  /** extra payload merged with `{ scheduledFor }` */
  payload?: Record<string, unknown>
  /** one job per active tenant (optionally only tenants that enabled a module) instead of one tenant-less job */
  perTenant?: { requireModule?: string }
  maxAttempts?: number
}

const NAME = /^[a-z][a-z0-9_.-]*\/[a-z][a-z0-9_.:-]*$/
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/
export const MIN_INTERVAL_MS = 1000

/** Validation problems for a schedule definition (empty = valid). */
export function scheduleProblems(s: ScheduleDef): string[] {
  const p: string[] = []
  if (!NAME.test(s.name)) p.push(`schedule name ${s.name} must be <owner>/<name>`)
  if (!NAME.test(s.jobType)) p.push(`schedule ${s.name}: job type ${s.jobType} must be <owner>/<name>`)
  if ('everyMs' in s.spec) {
    if (!Number.isInteger(s.spec.everyMs) || s.spec.everyMs < MIN_INTERVAL_MS) p.push(`schedule ${s.name}: everyMs must be an integer >= ${MIN_INTERVAL_MS}`)
  } else if (!('dailyAtUtc' in s.spec) || !HHMM.test(s.spec.dailyAtUtc)) p.push(`schedule ${s.name}: dailyAtUtc must be "HH:MM" (UTC)`)
  return p
}

/** Start of the period that contains `now` (the most recent due time at or before `now`). */
export function periodStart(spec: ScheduleSpec, now: Date): Date {
  if ('everyMs' in spec) return new Date(Math.floor(now.getTime() / spec.everyMs) * spec.everyMs)
  const [, hh, mm] = HHMM.exec(spec.dailyAtUtc)!
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(hh), Number(mm))
  return new Date(today <= now.getTime() ? today : today - 86_400_000)
}

export interface SchedulerOptions {
  system: SystemDatabase
  schedules: ScheduleDef[]
  /** how often `start()` ticks (default 30 s) */
  tickMs?: number
}

export function createScheduler(o: SchedulerOptions) {
  for (const s of o.schedules) {
    const p = scheduleProblems(s)
    if (p.length) throw new AppError('schedule_invalid', p.join('; '))
  }
  if (new Set(o.schedules.map((s) => s.name)).size !== o.schedules.length) throw new AppError('schedule_invalid', 'duplicate schedule names')
  const done = new Map<string, number>() // schedule name -> last period fully enqueued by this process
  let timer: NodeJS.Timeout | undefined
  let running = false

  async function tenantsFor(s: ScheduleDef): Promise<string[]> {
    const mod = s.perTenant?.requireModule ?? null
    const r = await o.system.query<{ id: string }>(
      `select id from platform.tenants where status = 'active' and ($1::text is null or $1 = any(enabled_modules)) order by id`, [mod])
    return r.rows.map((x) => x.id)
  }

  /** Enqueue everything due at `now`. Returns how many jobs this call created (duplicates are not counted). */
  async function tick(now = new Date()): Promise<number> {
    let created = 0
    for (const s of o.schedules) {
      const start = periodStart(s.spec, now)
      if (done.get(s.name) === start.getTime()) continue
      const period = start.toISOString()
      const payload = { ...s.payload, scheduledFor: period }
      try {
        const targets: (string | null)[] = s.perTenant ? await tenantsFor(s) : [null]
        for (const tenantId of targets) {
          const r = await enqueueSystem(o.system, s.jobType, payload, {
            tenantId, maxAttempts: s.maxAttempts, idempotencyKey: `schedule:${s.name}:${period}${tenantId ? `:${tenantId}` : ''}`,
          })
          if (r.created) created++
        }
        done.set(s.name, start.getTime())
        counter('schedule_ticks_total', { schedule: s.name }).inc()
      } catch (e) {
        captureError(e, { where: 'scheduler.tick', schedule: s.name })
      }
    }
    if (created) logger.info('scheduled jobs enqueued', { created })
    return created
  }

  return {
    tick,
    start() {
      if (running) return
      running = true
      const loop = async () => {
        if (!running) return
        await tick().catch((e) => captureError(e, { where: 'scheduler.loop' }))
        timer = setTimeout(loop, o.tickMs ?? 30_000)
      }
      void loop()
    },
    async stop() {
      running = false
      if (timer) clearTimeout(timer)
    },
  }
}
