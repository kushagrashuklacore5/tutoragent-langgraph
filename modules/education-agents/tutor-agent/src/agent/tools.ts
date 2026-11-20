/**
 * Tool registry and executor for the learning companion. A tool is a typed capability backed by the existing
 * domain services. The model can only REQUEST tools; the executor decides:
 *   - unknown tools, tools the model may not call, and invalid arguments are rejected;
 *   - consequential tools needing approval return `needs_approval` unless the orchestrator passes the student's
 *     approval (approval is never inferred from model output);
 *   - every run happens inside the caller's RLS transaction as the student (tools re-check enrolment), with a
 *     statement timeout, bounded retries for reads, idempotency for writes, output validation and a trace row.
 */
import { createHash } from 'node:crypto'
import type { ModuleDeps, Principal } from '@platform/contracts'
import type { Sql } from '@platform/tenancy-db'
import { status, TOOL_STATUS } from './status.ts'
import { validate, type Schema } from './schema.ts'

export type Capability = 'strategy' | 'curriculum' | 'teaching' | 'assessment' | 'revision' | 'progress' | 'resources'
export interface ToolContext { d: ModuleDeps; p: Principal; conversationId: string | null; now: Date; t: Sql }
export interface ToolDef<A = Record<string, unknown>, R = unknown> {
  name: string
  capability: Capability
  description: string
  input: Schema
  output: Schema
  effect: 'read' | 'write'
  approval: 'none' | 'required'
  /** false: only the orchestrator may run it (e.g. applying a plan after the student approved it) */
  modelCallable: boolean
  timeoutMs?: number
  /** extra attempts for transient failures (reads only) */
  retries?: number
  /** required for writes: same key → same result, executed once */
  idempotencyKey?: (args: A, ctx: Omit<ToolContext, 't'>) => string
  run(ctx: ToolContext, args: A): Promise<R>
}
export interface ToolOutcome {
  tool: string
  status: 'ok' | 'error' | 'rejected' | 'timeout' | 'needs_approval'
  result?: unknown
  error?: { code: string; message: string }
  durationMs: number
  attempts: number
  replayed?: boolean
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef<any, any>>()
  register<A, R>(t: ToolDef<A, R>): this {
    if (this.tools.has(t.name)) throw new Error(`tool ${t.name} registered twice`)
    if (t.effect === 'write' && !t.idempotencyKey) throw new Error(`write tool ${t.name} needs an idempotency key`)
    this.tools.set(t.name, t)
    return this
  }
  get(name: string) { return this.tools.get(name) }
  list() { return [...this.tools.values()] }
  /** compact catalogue for the model: only model-callable tools */
  catalog() {
    return this.list().filter((t) => t.modelCallable).map((t) => ({ tool: t.name, agent: t.capability, does: t.description, args: argSummary(t.input), needsApproval: t.approval === 'required' }))
  }
}

const argSummary = (s: Schema) => Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, `${v.enum ? v.enum.join('|') : v.type}${(s.required ?? []).includes(k) ? '' : '?'}${v.description ? ` (${v.description})` : ''}`]))

const DEFAULT_TIMEOUT_MS = 8000
const TRANSIENT_PG = new Set(['40001', '40P01'])
const isTransient = (e: unknown) => {
  const x = e as { code?: string; status?: number }
  return TRANSIENT_PG.has(String(x.code)) || x.status === 503
}
const SAFE = /^[\w\-:.@]{1,40}$/
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16)
/** Trace arguments without student free text: ids, numbers, booleans and short tokens kept; text digested. */
export function traceArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === 'number' || typeof v === 'boolean' || v === null || (typeof v === 'string' && SAFE.test(v)) ? v : `#${digest(v)}`]))
}

class ToolTimeout extends Error { code = 'tool_timeout' }
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => new Promise<T>((resolve, reject) => {
  const h = setTimeout(() => reject(new ToolTimeout(`timed out after ${ms} ms`)), ms)
  p.then((v) => { clearTimeout(h); resolve(v) }, (e) => { clearTimeout(h); reject(e) })
})

export interface ExecOptions { origin: 'model' | 'orchestrator'; approved?: boolean }

export async function executeTool(reg: ToolRegistry, base: Omit<ToolContext, 't'>, name: string, rawArgs: unknown, o: ExecOptions): Promise<ToolOutcome> {
  const started = Date.now()
  const def = reg.get(name)
  const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>
  const finish = async (out: Omit<ToolOutcome, 'durationMs' | 'tool'>, key?: string): Promise<ToolOutcome> => {
    const res: ToolOutcome = { tool: name, durationMs: Date.now() - started, ...out }
    // write tools record their successful trace inside their own transaction (atomic with the change)
    if (!(def?.effect === 'write' && res.status === 'ok')) await trace(base, res, args, key).catch(() => {})
    return res
  }
  if (!def) return finish({ status: 'rejected', attempts: 0, error: { code: 'unknown_tool', message: `No tool named ${name}` } })
  if (o.origin === 'model' && !def.modelCallable) return finish({ status: 'rejected', attempts: 0, error: { code: 'not_allowed', message: `${name} cannot be requested by the model` } })
  const problems = validate(def.input, args)
  if (problems.length) return finish({ status: 'rejected', attempts: 0, error: { code: 'invalid_args', message: problems.slice(0, 3).join('; ') } })
  if (def.approval === 'required' && !o.approved) return finish({ status: 'needs_approval', attempts: 0 })
  const st = TOOL_STATUS[name]
  if (st) status(st[0], st[1])

  const key = def.idempotencyKey?.(args as never, base)
  if (key) {
    const prior = await base.d.inTenant(base.p, (t) => t.query<{ result: unknown }>(
      `select result from education_tutor.agent_tool_calls where idempotency_key = $1 and status = 'ok'`, [key])).then((r) => r.rows[0])
    if (prior) return finish({ status: 'ok', result: prior.result, attempts: 0, replayed: true })
  }
  const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxAttempts = def.effect === 'read' ? 1 + (def.retries ?? 1) : 1
  let attempts = 0
  for (;;) {
    attempts++
    try {
      const run = base.d.inTenant(base.p, async (t) => {
        await t.query(`select set_config('statement_timeout', $1, true)`, [String(timeoutMs)])
        const result = await def.run({ ...base, t }, args as never)
        const bad = validate(def.output, result)
        if (bad.length) throw Object.assign(new Error(`tool result invalid: ${bad.slice(0, 2).join('; ')}`), { code: 'invalid_result' })
        if (def.effect === 'write') {
          await t.query(`insert into education_tutor.agent_tool_calls (tenant_id, user_id, conversation_id, tool, status, args, args_digest, duration_ms, attempts, idempotency_key, result)
            values (platform.current_tenant(), platform.current_user_id(), $1, $2, 'ok', $3, $4, $5, $6, $7, $8)`,
          [base.conversationId, name, JSON.stringify(traceArgs(args)), digest(args), Date.now() - started, attempts, key ?? null, JSON.stringify(result ?? null)])
        }
        return result
      })
      // reads are raced against the timeout; writes rely on the statement timeout (no "timed out but committed")
      const result = def.effect === 'read' ? await withTimeout(run, timeoutMs) : await run
      return finish({ status: 'ok', result, attempts }, key)
    } catch (e) {
      const err = e as { code?: string; message?: string; status?: number }
      if (key && err.code === '23505') {
        // a concurrent duplicate committed first: return its result
        const prior = await base.d.inTenant(base.p, (t) => t.query<{ result: unknown }>(`select result from education_tutor.agent_tool_calls where idempotency_key = $1 and status = 'ok'`, [key])).then((r) => r.rows[0])
        if (prior) return finish({ status: 'ok', result: prior.result, attempts, replayed: true })
      }
      if (attempts < maxAttempts && isTransient(e)) { await new Promise((r) => setTimeout(r, 150 * attempts)); continue }
      if (e instanceof ToolTimeout || err.code === '57014') return finish({ status: 'timeout', attempts, error: { code: 'timeout', message: `${name} took too long` } }, key)
      return finish({ status: 'error', attempts, error: { code: err.code && /^[a-z_]+$/.test(err.code) ? err.code : 'tool_failed', message: (err.message ?? 'failed').slice(0, 200) } }, key)
    }
  }
}

async function trace(base: Omit<ToolContext, 't'>, r: ToolOutcome, args: Record<string, unknown>, key?: string) {
  await base.d.inTenant(base.p, (t) => t.query(
    `insert into education_tutor.agent_tool_calls (tenant_id, user_id, conversation_id, tool, status, args, args_digest, error_code, duration_ms, attempts, idempotency_key)
     values (platform.current_tenant(), platform.current_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, null)`,
    [base.conversationId, r.tool, r.status, JSON.stringify(traceArgs(args)), digest(args), r.error?.code ?? null, r.durationMs, r.attempts]))
  void key
}
