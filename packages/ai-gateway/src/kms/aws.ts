import { registerSecret } from '@platform/observability'
import type { KeyManager } from '../secrets.ts'
import { kmsError, kmsRequest, type FetchLike, type KmsHttpOptions } from './http.ts'
import { signV4, type AwsCredentials } from './sigv4.ts'

/**
 * AWS KMS key manager: data keys are wrapped with KMS `Encrypt` / unwrapped with `Decrypt`
 * (JSON 1.1 protocol, SigV4-signed with node:crypto — no SDK).
 * API: https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html, API_Decrypt.html
 * The wrapped value is the KMS `CiphertextBlob` as returned (it names the key and key version, so
 * unwrap keeps working after automatic key rotation).
 */

export type AwsCredentialProvider = () => Promise<AwsCredentials>

const remember = (c: AwsCredentials): AwsCredentials => {
  registerSecret(c.secretAccessKey)
  if (c.sessionToken) registerSecret(c.sessionToken)
  return c
}

/** Fixed credentials (tests, or credentials injected by a secret manager). */
export const staticAwsCredentials = (c: AwsCredentials): AwsCredentialProvider => {
  remember(c)
  return async () => c
}

/** Cache a provider's credentials until 5 minutes before they expire. */
function cached(load: () => Promise<AwsCredentials>): AwsCredentialProvider {
  let cur: AwsCredentials | undefined
  let inflight: Promise<AwsCredentials> | undefined
  return async () => {
    if (cur && (!cur.expiresAt || cur.expiresAt - Date.now() > 300_000)) return cur
    inflight ??= load().then((c) => (cur = remember(c))).finally(() => (inflight = undefined))
    return inflight
  }
}

interface ProviderOpts { fetch?: FetchLike; timeoutMs?: number }

/**
 * Default chain, first that applies:
 * 1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (/ AWS_SESSION_TOKEN)
 * 2. container credentials (ECS task role / EKS Pod Identity): AWS_CONTAINER_CREDENTIALS_FULL_URI or
 *    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, with AWS_CONTAINER_AUTHORIZATION_TOKEN(_FILE)
 * 3. EC2 instance metadata (IMDSv2, token-protected)
 * Web-identity (IRSA) needs STS AssumeRoleWithWebIdentity and is not implemented; use Pod Identity.
 */
export function awsCredentialChain(env: NodeJS.ProcessEnv, o: ProviderOpts & { imdsEndpoint?: string; readFile?: (p: string) => Promise<string> } = {}): AwsCredentialProvider {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return staticAwsCredentials({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, sessionToken: env.AWS_SESSION_TOKEN || undefined })
  }
  const doFetch = o.fetch ?? fetch
  const timeout = () => AbortSignal.timeout(o.timeoutMs ?? 2000)
  const full = env.AWS_CONTAINER_CREDENTIALS_FULL_URI ?? (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ? `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}` : undefined)
  if (full) {
    return cached(async () => {
      let token = env.AWS_CONTAINER_AUTHORIZATION_TOKEN
      if (env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
        const read = o.readFile ?? (async (p: string) => (await import('node:fs/promises')).readFile(p, 'utf8'))
        token = (await read(env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE)).trim()
      }
      const res = await doFetch(full, { headers: token ? { authorization: token } : {}, signal: timeout() }).catch(() => null)
      if (!res?.ok) throw kmsError('aws', 'credentials', `container credentials endpoint unavailable${res ? ` (HTTP ${res.status})` : ''}`)
      const j = (await res.json()) as { AccessKeyId: string; SecretAccessKey: string; Token?: string; Expiration?: string }
      return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token, expiresAt: j.Expiration ? Date.parse(j.Expiration) : undefined }
    })
  }
  const imds = (o.imdsEndpoint ?? env.AWS_EC2_METADATA_SERVICE_ENDPOINT ?? 'http://169.254.169.254').replace(/\/+$/, '')
  return cached(async () => {
    const fail = (what: string) => kmsError('aws', 'credentials', `no credentials: env vars absent and instance metadata ${what}`)
    const t = await doFetch(`${imds}/latest/api/token`, { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: timeout() }).catch(() => null)
    if (!t?.ok) throw fail('unreachable')
    const token = await t.text()
    const h = { 'x-aws-ec2-metadata-token': token }
    const role = await doFetch(`${imds}/latest/meta-data/iam/security-credentials/`, { headers: h, signal: timeout() }).catch(() => null)
    if (!role?.ok) throw fail('has no instance role')
    const name = (await role.text()).split('\n')[0]!.trim()
    const c = await doFetch(`${imds}/latest/meta-data/iam/security-credentials/${encodeURIComponent(name)}`, { headers: h, signal: timeout() }).catch(() => null)
    if (!c?.ok) throw fail('returned no credentials')
    const j = (await c.json()) as { AccessKeyId: string; SecretAccessKey: string; Token?: string; Expiration?: string }
    return { accessKeyId: j.AccessKeyId, secretAccessKey: j.SecretAccessKey, sessionToken: j.Token, expiresAt: j.Expiration ? Date.parse(j.Expiration) : undefined }
  })
}

export interface AwsKmsOptions extends KmsHttpOptions {
  region: string
  keyId: string
  credentials: AwsCredentialProvider
  endpoint?: string
  /** bound to every wrapped key; unwrap fails if it differs. Default: { purpose: 'ekbharat/ai-data-key' } */
  encryptionContext?: Record<string, string>
  /** clock override for tests */
  now?: () => Date
}

/** KMS returns `__type` like `com.amazonaws.kms#InvalidCiphertextException` or `InvalidCiphertextException`. */
const errType = (text: string, headers: Headers) => {
  let t = headers.get('x-amzn-errortype') ?? ''
  try {
    t = (JSON.parse(text) as { __type?: string }).__type ?? t
  } catch { /* not JSON */ }
  return t.split('#').pop()!.split(':')[0]!.replace(/[^A-Za-z]/g, '') || 'UnknownError'
}

export function awsKmsKeyManager(o: AwsKmsOptions): KeyManager {
  const endpoint = (o.endpoint ?? `https://kms.${o.region}.amazonaws.com`).replace(/\/+$/, '') + '/'
  const context = o.encryptionContext ?? { purpose: 'ekbharat/ai-data-key' }

  async function call<T>(op: 'Encrypt' | 'Decrypt', payload: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(payload)
    const res = await kmsRequest('aws', op, o, async () => {
      const signed = signV4({ method: 'POST', url: endpoint, body, headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `TrentService.${op}` } },
        await o.credentials(), o.region, 'kms', o.now?.() ?? new Date())
      const { host: _host, ...headers } = signed.headers // fetch sets Host itself
      return { url: endpoint, init: { method: 'POST', headers, body } }
    }, (r) => r.status >= 500 || /Throttling|KMSInternal|DependencyTimeout/.test(errType(r.text, r.headers)))
    if (res.status >= 300) {
      const type = errType(res.text, res.headers)
      const code = type === 'InvalidCiphertextException' || type === 'IncorrectKeyException' ? 'kms_unwrap_failed'
        : type === 'AccessDeniedException' || type === 'UnrecognizedClientException' || type === 'InvalidSignatureException' ? 'kms_access_denied' : 'kms_error'
      throw kmsError('aws', op, `HTTP ${res.status} ${type}`, { status: res.status, code })
    }
    return JSON.parse(res.text) as T
  }

  return {
    id: `aws-kms:${o.region}:${o.keyId}`,
    async wrap(dataKey) {
      const r = await call<{ CiphertextBlob?: string }>('Encrypt', { KeyId: o.keyId, Plaintext: dataKey.toString('base64'), EncryptionContext: context })
      if (!r.CiphertextBlob) throw kmsError('aws', 'Encrypt', 'response without CiphertextBlob')
      return Buffer.from(r.CiphertextBlob, 'base64')
    },
    async unwrap(wrapped) {
      // KeyId pins decryption to the configured key (a blob for another key is rejected by KMS)
      const r = await call<{ Plaintext?: string }>('Decrypt', { CiphertextBlob: wrapped.toString('base64'), EncryptionContext: context, KeyId: o.keyId })
      if (!r.Plaintext) throw kmsError('aws', 'Decrypt', 'response without Plaintext')
      return Buffer.from(r.Plaintext, 'base64')
    },
  }
}
