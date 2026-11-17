import { AppError } from './errors.ts'

export type Environment = 'development' | 'test' | 'production'

export interface PlatformConfig {
  env: Environment
  /** owner / migration connection */
  databaseUrl: string
  /** runtime connection: role without BYPASSRLS, not table owner */
  appDatabaseUrl: string
  /** 32 bytes; wraps per-scope data keys (local key manager). Replaced by a cloud KMS in production infra. */
  masterKey: Buffer
  httpPort: number
  publicBaseUrl: string
  allowedOrigins: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k]
  if (!v) throw new AppError('config_missing', `Missing required environment variable ${k}`)
  return v
}

/** Load and validate configuration from the environment. Fails fast on missing or invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const e = (env.PLATFORM_ENV ?? 'development') as Environment
  if (!['development', 'test', 'production'].includes(e)) throw new AppError('config_invalid', 'PLATFORM_ENV must be development|test|production')
  const masterKey = Buffer.from(req(env, 'PLATFORM_MASTER_KEY'), 'base64')
  if (masterKey.length !== 32) throw new AppError('config_invalid', 'PLATFORM_MASTER_KEY must be 32 bytes, base64-encoded')
  return {
    env: e,
    databaseUrl: req(env, 'DATABASE_URL'),
    appDatabaseUrl: req(env, 'APP_DATABASE_URL'),
    masterKey,
    httpPort: Number(env.PORT ?? 8080),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: (env.LOG_LEVEL as PlatformConfig['logLevel']) ?? 'info',
  }
}
