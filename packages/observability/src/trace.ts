import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes } from 'node:crypto'
import { histogram } from './metrics.ts'

export interface TraceContext {
  traceId: string
  spanId: string
  parentId?: string
  name: string
}
const als = new AsyncLocalStorage<TraceContext>()
const hex = (n: number) => randomBytes(n).toString('hex')

export const currentTrace = (): TraceContext | undefined => als.getStore()

/** Run `fn` in a span (child of the current one, or a new trace). Records `span_duration_ms{span}`. */
export async function withSpan<T>(name: string, fn: (span: TraceContext) => Promise<T>, traceId?: string): Promise<T> {
  const parent = als.getStore()
  const span: TraceContext = { traceId: traceId ?? parent?.traceId ?? hex(16), spanId: hex(8), parentId: parent?.spanId, name }
  const start = performance.now()
  try {
    return await als.run(span, () => fn(span))
  } finally {
    histogram('span_duration_ms', { span: name }).observe(performance.now() - start)
  }
}
