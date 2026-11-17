import { log } from './log.ts'
import { counter } from './metrics.ts'

export type ErrorReporter = (err: unknown, context: Record<string, unknown>) => void
const reporters: ErrorReporter[] = []

/** Plug in an external error tracker without changing call sites. */
export function addErrorReporter(r: ErrorReporter): void {
  reporters.push(r)
}

/** Capture an unexpected error: redacted structured log, `errors_total` counter, registered reporters. */
export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  const code = (err as { code?: unknown } | null)?.code ?? 'unknown'
  counter('errors_total', { code: String(code) }).inc()
  log('error', err instanceof Error ? err.message : String(err), { ...context, error: err, stack: err instanceof Error ? err.stack : undefined })
  for (const r of reporters) {
    try {
      r(err, context)
    } catch {
      /* a reporter must never break the caller */
    }
  }
}
