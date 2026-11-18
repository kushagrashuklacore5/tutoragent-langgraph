import { hkdfSync } from 'node:crypto'
import { AppError } from './errors.ts'

export type Environment = 'development' | 'test' | 'production'

/**
 * Which key manager wraps the per-scope data keys (AI_GATEWAY § 11.1). Holds identifiers only —
 * cloud credentials are resolved by the key manager from the environment / instance metadata.
 * The India region (O-3) is open, so both AWS KMS and Google Cloud KMS are supported.
 */
export type KmsConfig =
  | { provider: 'local' }
  | {
    provider: 'aws'
    /** e.g. ap-south-1 (Mumbai) or ap-south-2 (Hyderabad) */
    region: string
    /** key id, key ARN, alias name or alias ARN */
    keyId: string
    /** override (VPC endpoint, tests); default https://kms.<region>.amazonaws.com */
    endpoint?: string
  }
  | {
    provider: 'gcp'
    /** projects/<p>/locations/asia-south1/keyRings/<r>/cryptoKeys/<k> */
    keyName: string
    /** override (Private Service Connect, tests); default https://cloudkms.googleapis.com */
    endpoint?: string
    /** service-account JSON key file; when absent the metadata server (GKE / Cloud Run / GCE) is used */
    credentialsFile?: string
  }

export interface PlatformConfig {
  env: Environment
  /** owner / migration connection */
  databaseUrl: string
  /** runtime connection: role without BYPASSRLS, not table owner */
  appDatabaseUrl: string
  /**
   * 32 bytes; wraps per-scope data keys with the local key manager (dev/test only).
   * Empty when a cloud KMS is configured (the local key manager refuses an empty key).
   */
  masterKey: Buffer
  httpPort: number
  publicBaseUrl: string
  allowedOrigins: string[]
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** privileged (BYPASSRLS) runtime connection; defaults to `databaseUrl` outside production */
  systemDatabaseUrl: string
  /** true when SYSTEM_DATABASE_URL was set explicitly */
  systemDatabaseUrlExplicit: boolean
  /** bearer token protecting /metrics in production */
  metricsToken?: string
  kms: KmsConfig
}

function req(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k]
  if (!v) throw new AppError('config_missing', `Missing required environment variable ${k}`)
  return v
}

function loadKms(env: NodeJS.ProcessEnv): KmsConfig {
  const provider = env.KMS_PROVIDER ?? 'local'
  if (provider === 'local') return { provider }
  if (provider === 'aws') {
    const region = env.KMS_AWS_REGION ?? env.AWS_REGION ?? 'ap-south-1'
    if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new AppError('config_invalid', 'KMS_AWS_REGION is not a valid AWS region')
    return { provider, region, keyId: req(env, 'KMS_AWS_KEY_ID'), ...(env.KMS_AWS_ENDPOINT ? { endpoint: env.KMS_AWS_ENDPOINT } : {}) }
  }
  if (provider === 'gcp') {
    const keyName = req(env, 'KMS_GCP_KEY_NAME')
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(keyName)) {
      throw new AppError('config_invalid', 'KMS_GCP_KEY_NAME must be projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>')
    }
    return {
      provider, keyName,
      ...(env.KMS_GCP_ENDPOINT ? { endpoint: env.KMS_GCP_ENDPOINT } : {}),
      ...(env.GOOGLE_APPLICATION_CREDENTIALS ? { credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS } : {}),
    }
  }
  throw new AppError('config_invalid', 'KMS_PROVIDER must be local|aws|gcp')
}

/** Load and validate configuration from the environment. Fails fast on missing or invalid values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const e = (env.PLATFORM_ENV ?? 'development') as Environment
  if (!['development', 'test', 'production'].includes(e)) throw new AppError('config_invalid', 'PLATFORM_ENV must be development|test|production')
  const kms = loadKms(env)
  // the master key is only needed by the local key manager
  const masterKey = kms.provider === 'local' ? Buffer.from(req(env, 'PLATFORM_MASTER_KEY'), 'base64') : Buffer.alloc(0)
  if (kms.provider === 'local' && masterKey.length !== 32) throw new AppError('config_invalid', 'PLATFORM_MASTER_KEY must be 32 bytes, base64-encoded')
  const databaseUrl = req(env, 'DATABASE_URL')
  return {
    env: e,
    databaseUrl,
    appDatabaseUrl: req(env, 'APP_DATABASE_URL'),
    masterKey,
    httpPort: Number(env.PORT ?? 8080),
    publicBaseUrl: env.PUBLIC_BASE_URL ?? 'http://localhost:8080',
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    logLevel: (env.LOG_LEVEL as PlatformConfig['logLevel']) ?? 'info',
    systemDatabaseUrl: env.SYSTEM_DATABASE_URL || databaseUrl,
    systemDatabaseUrlExplicit: !!env.SYSTEM_DATABASE_URL,
    metricsToken: env.METRICS_TOKEN || undefined,
    kms,
  }
}

const dbUser = (url: string): string => {
  try {
    return decodeURIComponent(new URL(url).username)
  } catch {
    return ''
  }
}

/**
 * Production fail-closed rules that can be decided from configuration alone (FOUNDATION_IMPLEMENTATION F12).
 * Returns human-readable problems (never secret values); empty = ok. Database-role checks need a
 * connection and are done by the hosts at startup and by `tooling/preflight.ts`.
 */
export function productionConfigProblems(c: PlatformConfig): string[] {
  const p: string[] = []
  if (c.kms.provider === 'local') p.push('KMS_PROVIDER must be aws or gcp in production (the local key manager is dev/test only)')
  let base: URL | undefined
  try {
    base = new URL(c.publicBaseUrl)
  } catch {
    p.push('PUBLIC_BASE_URL is not a valid URL')
  }
  // session cookies get the Secure attribute exactly when the public base URL is https (apps/api/src/app.ts)
  if (base && base.protocol !== 'https:') p.push('PUBLIC_BASE_URL must be https in production (required for Secure session cookies)')
  if (base && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) p.push('PUBLIC_BASE_URL must not point at localhost in production')
  for (const o of c.allowedOrigins) if (!o.startsWith('https://')) p.push(`ALLOWED_ORIGINS entry ${o} must be https in production`)
  if (!c.metricsToken) p.push('METRICS_TOKEN is required in production')
  else if (c.metricsToken.length < 24) p.push('METRICS_TOKEN must be at least 24 characters')
  if (!c.systemDatabaseUrlExplicit) p.push('SYSTEM_DATABASE_URL must be set explicitly in production')
  const users = { DATABASE_URL: dbUser(c.databaseUrl), APP_DATABASE_URL: dbUser(c.appDatabaseUrl), SYSTEM_DATABASE_URL: dbUser(c.systemDatabaseUrl) }
  for (const [k, u] of Object.entries(users)) if (!u) p.push(`${k} must name a database user`)
  if (new Set(Object.values(users)).size !== 3) p.push('DATABASE_URL, APP_DATABASE_URL and SYSTEM_DATABASE_URL must use three different database roles (owner, app, system)')
  return p
}

/** Where document originals are stored and how uploads are malware-scanned (packages/documents). */
export type DocumentStorageConfig =
  | { enabled: false }
  | {
    enabled: true
    store: { kind: 'local'; dir: string; key: Buffer }
    scanner: { kind: 'dev-noop' } | { kind: 'clamd'; host: string; port: number; timeoutMs: number }
  }

/**
 * Document storage settings. Fail-closed in production: the local filesystem store and the no-op
 * scanner are refused, and no cloud object store exists yet (F12, S3-compatible in the India region),
 * so production must set `DOCUMENTS_ENABLED=false` until that store exists.
 *   DOCUMENTS_ENABLED (default true), DOCUMENT_STORE (local), DOCUMENT_STORE_DIR (.data/documents),
 *   DOCUMENT_STORE_KEY (32 bytes base64; derived from PLATFORM_MASTER_KEY outside production when unset),
 *   DOCUMENT_SCANNER (dev-noop | clamd; default dev-noop outside production), CLAMD_HOST, CLAMD_PORT (3310), CLAMD_TIMEOUT_MS
 */
export function loadDocumentStorageConfig(env: NodeJS.ProcessEnv, c: PlatformConfig): DocumentStorageConfig {
  const prod = c.env === 'production'
  if (env.DOCUMENTS_ENABLED === 'false') return { enabled: false }
  const bad = (m: string): never => { throw new AppError('documents_not_configured', m) }
  const scannerKind = env.DOCUMENT_SCANNER ?? (prod ? 'clamd' : 'dev-noop')
  if (prod && scannerKind !== 'clamd') bad('The no-op document scanner is not allowed in production; use DOCUMENT_SCANNER=clamd')
  const store = env.DOCUMENT_STORE ?? 'local'
  if (store !== 'local') bad(`Unknown DOCUMENT_STORE ${store} (only "local" exists; the cloud object store is F12)`)
  if (prod) bad('No production object store exists yet (F12): the local filesystem store is refused in production; set DOCUMENTS_ENABLED=false')
  let key: Buffer
  if (env.DOCUMENT_STORE_KEY) key = Buffer.from(env.DOCUMENT_STORE_KEY, 'base64')
  else if (c.masterKey.length === 32) key = Buffer.from(hkdfSync('sha256', c.masterKey, Buffer.alloc(0), 'ekbharat/documents-store/v1', 32))
  else key = bad('DOCUMENT_STORE_KEY is required when no local master key is configured')
  if (key.length !== 32) bad('DOCUMENT_STORE_KEY must be 32 bytes, base64-encoded')
  let scanner: Extract<DocumentStorageConfig, { enabled: true }>['scanner']
  if (scannerKind === 'dev-noop') scanner = { kind: 'dev-noop' }
  else if (scannerKind === 'clamd') {
    const port = Number(env.CLAMD_PORT ?? 3310)
    if (!env.CLAMD_HOST) bad('CLAMD_HOST is required for DOCUMENT_SCANNER=clamd')
    if (!Number.isInteger(port) || port <= 0) bad('CLAMD_PORT is invalid')
    scanner = { kind: 'clamd', host: env.CLAMD_HOST!, port, timeoutMs: Number(env.CLAMD_TIMEOUT_MS ?? 30_000) }
  } else scanner = bad('DOCUMENT_SCANNER must be dev-noop|clamd')
  return { enabled: true, store: { kind: 'local', dir: env.DOCUMENT_STORE_DIR ?? '.data/documents', key }, scanner }
}

/** Throw `config_unsafe_for_production` listing every problem when `env` is production. */
export function assertProductionReady(c: PlatformConfig, extraProblems: string[] = []): void {
  if (c.env !== 'production') return
  const p = [...productionConfigProblems(c), ...extraProblems]
  if (p.length) throw new AppError('config_unsafe_for_production', `Refusing to start in production:\n- ${p.join('\n- ')}`, { details: { problems: p } })
}
