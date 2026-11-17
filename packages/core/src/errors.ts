/** Typed application error. `expose` controls whether `message` may be shown to API clients. */
export class AppError extends Error {
  readonly code: string
  readonly status: number
  readonly expose: boolean
  readonly details?: Record<string, unknown>
  constructor(code: string, message: string, opts: { status?: number; expose?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, { cause: opts.cause })
    this.name = 'AppError'
    this.code = code
    this.status = opts.status ?? 500
    this.expose = opts.expose ?? this.status < 500
    this.details = opts.details
  }
}
export const badRequest = (code: string, msg: string, details?: Record<string, unknown>) => new AppError(code, msg, { status: 400, details })
export const unauthorized = (msg = 'Authentication required') => new AppError('unauthorized', msg, { status: 401 })
export const forbidden = (msg = 'Not allowed') => new AppError('forbidden', msg, { status: 403 })
export const notFound = (what = 'Resource') => new AppError('not_found', `${what} not found`, { status: 404 })
export const conflict = (code: string, msg: string) => new AppError(code, msg, { status: 409 })
