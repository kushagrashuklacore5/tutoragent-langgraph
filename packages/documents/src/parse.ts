import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AppError } from '@platform/core'
import type { DocumentKind } from './validate.ts'
import { MAX_PAGES } from './validate.ts'

export interface ParsedDocument {
  locatorKind: 'page' | 'slide' | 'section'
  pages: string[]
}

/**
 * Untrusted documents are parsed in a SEPARATE PROCESS per document (not a worker thread):
 *   - pdf.js leaks native memory per isolate; with worker threads that memory was never returned and the
 *     host process aborted after ~100 PDFs ("Zone Allocation failed", ERR_WORKER_INIT_FAILED, segfaults) —
 *     the root cause of intermittent test-file failures and a crashed document worker. Process exit frees
 *     everything.
 *   - a parser crash, hang or memory blow-up kills only the child; on timeout it is killed outright (safe for a
 *     process, unlike force-terminating a thread inside pdf.js on Windows).
 * Children run at most MAX_PARSE_PROCESSES at a time per host process.
 */
export const MAX_PARSE_PROCESSES = Math.max(1, Number(process.env.DOCUMENT_PARSE_CONCURRENCY ?? 1))
const WORKER = fileURLToPath(new URL('./parse-worker.ts', import.meta.url))

let active = 0
const waiting: (() => void)[] = []
async function acquire(): Promise<() => void> {
  if (active >= MAX_PARSE_PROCESSES) await new Promise<void>((r) => waiting.push(r))
  active++
  let released = false
  return () => {
    if (released) return
    released = true
    active--
    waiting.shift()?.()
  }
}

export async function parseDocument(kind: DocumentKind, data: Buffer, opts: { timeoutMs?: number; maxHeapMb?: number; maxPages?: number } = {}): Promise<ParsedDocument> {
  const release = await acquire()
  try {
    return await runChild(kind, data, opts)
  } finally {
    release()
  }
}

function runChild(kind: DocumentKind, data: Buffer, opts: { timeoutMs?: number; maxHeapMb?: number; maxPages?: number }): Promise<ParsedDocument> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof fork>
    try {
      child = fork(WORKER, [], {
        execArgv: [`--max-old-space-size=${opts.maxHeapMb ?? 512}`, '--stack-size=4000'],
        serialization: 'advanced', // binary-safe IPC for the document bytes
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        // the parser needs no secrets or configuration from the host (SystemRoot is required by Windows itself)
        env: { NODE_OPTIONS: '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      })
    } catch (e) {
      reject(new AppError('parse_unavailable', 'Document processing is temporarily unavailable', { status: 503, cause: e }))
      return
    }
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => reject(new AppError('parse_timeout', 'Document processing took too long', { status: 422 })))
    }, opts.timeoutMs ?? 120_000)
    child.once('message', (m: { ok: boolean; error?: string } & ParsedDocument) => finish(() => {
      if (m.ok) resolve({ locatorKind: m.locatorKind, pages: m.pages })
      else reject(new AppError('parse_failed', `Could not read this document: ${m.error}`, { status: 422 }))
    }))
    child.once('error', (e) => finish(() => reject(new AppError('parse_unavailable', `Document processing is temporarily unavailable (${(e as { code?: string }).code ?? 'start failed'})`, { status: 503, cause: e }))))
    child.once('exit', (code, signal) => finish(() => reject(new AppError('parse_failed',
      `Could not read this document (${code === 134 || /memory/i.test(String(signal)) ? 'too large to process' : `parser exited with ${signal ?? code}`})`, { status: 422 }))))
    child.send({ kind, data: new Uint8Array(data), maxPages: opts.maxPages ?? MAX_PAGES })
  })
}
