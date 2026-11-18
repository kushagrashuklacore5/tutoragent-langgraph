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

export type SpanAttributes = Record<string, string | number | boolean>

/** A completed span, kept only while span recording is enabled (an exporter is configured). */
export interface FinishedSpan extends TraceContext {
  /** epoch nanoseconds, as decimal strings (exceed Number precision) */
  startTimeUnixNano: string
  endTimeUnixNano: string
  durationMs: number
  error?: { name: string; message: string }
  attributes: SpanAttributes
}

// ── bounded buffer of finished spans (off by default: zero cost unless an exporter enables it) ──
let recordCapacity = 0
let finished: FinishedSpan[] = []
let droppedSpans = 0

/** Start (capacity > 0) or stop (0) recording finished spans. Oldest spans are dropped when full. */
export function setSpanRecording(capacity: number): void {
  recordCapacity = Math.max(0, Math.floor(capacity))
  if (recordCapacity === 0) finished = []
  else if (finished.length > recordCapacity) {
    droppedSpans += finished.length - recordCapacity
    finished = finished.slice(-recordCapacity)
  }
}
export const isSpanRecording = (): boolean => recordCapacity > 0

/** Remove and return up to `max` finished spans (oldest first). */
export function drainFinishedSpans(max = Infinity): FinishedSpan[] {
  return finished.splice(0, Math.min(max, finished.length))
}
/** Spans currently buffered, and the total dropped because the buffer was full. */
export const spanBufferStats = () => ({ buffered: finished.length, dropped: droppedSpans, capacity: recordCapacity })

const nowNs = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n

/** Run `fn` in a span (child of the current one, or a new trace). Records `span_duration_ms{span}`. */
export async function withSpan<T>(name: string, fn: (span: TraceContext) => Promise<T>, traceId?: string, attributes?: SpanAttributes): Promise<T> {
  const parent = als.getStore()
  const span: TraceContext = { traceId: traceId ?? parent?.traceId ?? hex(16), spanId: hex(8), parentId: parent?.spanId, name }
  const start = performance.now()
  const startNs = recordCapacity ? nowNs() : 0n
  let error: FinishedSpan['error']
  try {
    return await als.run(span, () => fn(span))
  } catch (e) {
    if (recordCapacity) error = { name: e instanceof Error ? e.name : 'Error', message: e instanceof Error ? e.message : String(e) }
    throw e
  } finally {
    const durationMs = performance.now() - start
    histogram('span_duration_ms', { span: name }).observe(durationMs)
    if (recordCapacity) {
      if (finished.length >= recordCapacity) {
        finished.shift()
        droppedSpans++
      }
      finished.push({ ...span, startTimeUnixNano: startNs.toString(), endTimeUnixNano: nowNs().toString(), durationMs, error, attributes: attributes ?? {} })
    }
  }
}
