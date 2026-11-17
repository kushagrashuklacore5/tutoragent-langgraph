import { redact } from './redact.ts'
import { currentTrace } from './trace.ts'

export type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
export type LogSink = (line: string) => void

let minLevel: Level = (process.env.LOG_LEVEL as Level | undefined) ?? 'info'
let sink: LogSink = (line) => process.stdout.write(line + '\n')

export function configureLogging(opts: { level?: Level; sink?: LogSink }): void {
  if (opts.level) minLevel = opts.level
  if (opts.sink) sink = opts.sink
}

/** Structured JSON logs. Fields are redacted; trace and span ids are attached automatically. */
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[minLevel]) return
  const t = currentTrace()
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(t ? { traceId: t.traceId, spanId: t.spanId } : {}),
    ...(redact(fields) as Record<string, unknown>),
  }
  sink(JSON.stringify(rec))
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
}
