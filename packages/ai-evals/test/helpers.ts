import { currentTrace } from '@platform/observability'
import type { RunInput, RunResult } from '@platform/ai-gateway'
import type { EvalCase, GatewayLike, MeteringReader, Observation } from '../src/index.ts'

export const obs = (o: Partial<Observation> = {}): Observation => ({
  text: '', latencyMs: 10, ttftMs: null, inputTokens: 1, outputTokens: 1, costMicros: null, currency: null, meta: {}, ...o,
})

export const mkCase = (o: Partial<EvalCase> = {}): EvalCase => ({
  id: 'c1', task: 'demo.task', input: { messages: [{ role: 'user', content: 'hi' }] }, context: {}, expect: [], tags: [], split: 'dev', source: 'synthetic', ...o,
})

/**
 * In-memory gateway double for runner unit tests. `reply` decides each call's outcome; every call is
 * "metered" under the current trace id so the runner's trace-based cost lookup works as with the real gateway.
 */
export function stubGateway(reply: (taskId: string, input: RunInput) => Promise<{ text: string; json?: unknown } | Error> | { text: string; json?: unknown } | Error, o: { costMicros?: number; delayMs?: number } = {}) {
  const ops = new Map<string, { cost: number | null }[]>()
  let inFlight = 0
  const stats = { calls: 0, maxInFlight: 0 }
  const gateway: GatewayLike = {
    async run(taskId: string, input: RunInput): Promise<RunResult> {
      stats.calls++
      inFlight++
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
      try {
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
        const r = await reply(taskId, input)
        const trace = currentTrace()?.traceId ?? 'none'
        ops.set(trace, [...(ops.get(trace) ?? []), { cost: o.costMicros ?? null }])
        if (r instanceof Error) throw r
        return {
          text: r.text, json: r.json, toolCalls: [], finish: 'stop', usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: null, reasoningTokens: null }, operationId: 'op',
          route: { deploymentId: 'dep-1', connectionId: 'conn-1', adapter: 'stub', modelId: 'stub-model', attempt: 1, fallback: false },
        }
      } finally {
        inFlight--
      }
    },
    async *stream() {
      throw new Error('not used')
    },
    async embed() {
      throw new Error('not used')
    },
  }
  const metering: MeteringReader = {
    async query<T>(_sql: string, params?: unknown[]) {
      const rows = ops.get(String(params?.[0])) ?? []
      const costs = rows.map((r) => r.cost).filter((c): c is number => c !== null)
      return { rows: [{ cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null, currency: costs.length ? 'INR' : null, input_tokens: null, output_tokens: null }] as T[] }
    },
  }
  return { gateway, metering, stats }
}

export function gatewayError(kind: string, message = kind): Error {
  return Object.assign(new Error(message), { kind })
}
