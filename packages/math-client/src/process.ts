import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError } from '@platform/core'
import { logger } from '@platform/observability'
import { createMathClient, type MathClientOptions } from './client.ts'
import type { MathChecker } from './types.ts'

/** Default location of the Python service inside the repository. */
export const DEFAULT_SERVICE_DIR = resolve(fileURLToPath(new URL('../../../services/math-solver', import.meta.url)))

export interface StartMathSolverOptions {
  /** services/math-solver directory (env MATH_SOLVER_DIR) */
  serviceDir?: string
  /** 0 = pick a free port (default) */
  port?: number
  workers?: number
  /** service-side wall-clock limit per request, seconds (default 2) */
  timeoutSeconds?: number
  /** how long to wait for the workers to import SymPy (default 60 s) */
  startupTimeoutMs?: number
}

export interface MathSolverProcess {
  baseUrl: string
  client(opts?: Omit<MathClientOptions, 'baseUrl'>): MathChecker
  stop(): Promise<void>
}

export function venvPython(serviceDir: string): string {
  return process.platform === 'win32' ? join(serviceDir, '.venv', 'Scripts', 'python.exe') : join(serviceDir, '.venv', 'bin', 'python')
}

/**
 * Start the local solver for development and tests (production runs the container). Uses the
 * service's own virtualenv — run `python services/math-solver/setup_env.py` once first.
 */
export async function startMathSolver(opts: StartMathSolverOptions = {}): Promise<MathSolverProcess> {
  const serviceDir = resolve(opts.serviceDir ?? process.env.MATH_SOLVER_DIR ?? DEFAULT_SERVICE_DIR)
  const python = venvPython(serviceDir)
  if (!existsSync(python)) {
    throw new AppError('math_solver_not_installed', `maths solver virtualenv missing; run: python ${join(serviceDir, 'setup_env.py')}`)
  }
  const args = ['-m', 'solver.server', '--host', '127.0.0.1', '--port', String(opts.port ?? 0),
    '--workers', String(opts.workers ?? 2), '--timeout', String(opts.timeoutSeconds ?? 2)]
  const child: ChildProcess = spawn(python, args, { cwd: serviceDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  child.stderr?.on('data', (c: Buffer) => { stderr = (stderr + c.toString()).slice(-4000) })

  const exited = new Promise<void>((res) => child.once('exit', () => res()))
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await exited
    }
  }

  try {
    const baseUrl = await new Promise<string>((res, rej) => {
      let buf = ''
      const timer = setTimeout(() => rej(new Error('maths solver did not start listening')), 30_000)
      child.stdout?.on('data', (c: Buffer) => {
        buf += c.toString()
        const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buf)
        if (m) { clearTimeout(timer); res(m[1]!) }
      })
      child.once('exit', (code) => { clearTimeout(timer); rej(new Error(`maths solver exited (${code}): ${stderr.trim()}`)) })
      child.once('error', (e) => { clearTimeout(timer); rej(e) })
    })
    const probe = createMathClient({ baseUrl, timeoutMs: 2000 })
    const deadline = Date.now() + (opts.startupTimeoutMs ?? 60_000)
    while (!(await probe.healthy())) {
      if (Date.now() > deadline) throw new Error('maths solver workers did not become ready')
      await new Promise((r) => setTimeout(r, 200))
    }
    logger.info('math solver started', { baseUrl })
    return { baseUrl, client: (o) => createMathClient({ ...o, baseUrl }), stop }
  } catch (e) {
    await stop()
    throw new AppError('math_solver_start_failed', (e as Error).message, { cause: e })
  }
}
