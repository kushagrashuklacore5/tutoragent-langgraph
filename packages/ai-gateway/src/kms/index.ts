import { AppError, type Environment, type KmsConfig } from '@platform/core'
import { localKeyManager, type KeyManager } from '../secrets.ts'
import { awsCredentialChain, awsKmsKeyManager } from './aws.ts'
import { gcpTokenSource, gcpKmsKeyManager } from './gcp.ts'
import type { FetchLike } from './http.ts'

export * from './sigv4.ts'
export * from './aws.ts'
export * from './gcp.ts'
export { kmsError, type KmsHttpOptions } from './http.ts'

/**
 * Build the configured KeyManager. The local (master-key) manager is refused in production;
 * cloud managers resolve credentials from the environment / instance metadata, never from config.
 */
export async function keyManagerFromConfig(
  kms: KmsConfig,
  o: { env: Environment; masterKey?: Buffer; processEnv?: NodeJS.ProcessEnv; fetch?: FetchLike; timeoutMs?: number },
): Promise<KeyManager> {
  if (kms.provider === 'local') {
    if (o.env === 'production') throw new AppError('kms_local_in_production', 'The local key manager is not allowed in production; set KMS_PROVIDER=aws|gcp')
    if (!o.masterKey) throw new AppError('config_missing', 'PLATFORM_MASTER_KEY is required for the local key manager')
    return localKeyManager(o.masterKey)
  }
  if (kms.provider === 'aws') {
    return awsKmsKeyManager({
      region: kms.region, keyId: kms.keyId, endpoint: kms.endpoint, fetch: o.fetch, timeoutMs: o.timeoutMs,
      credentials: awsCredentialChain(o.processEnv ?? process.env, { fetch: o.fetch }),
    })
  }
  return gcpKmsKeyManager({ keyName: kms.keyName, endpoint: kms.endpoint, fetch: o.fetch, timeoutMs: o.timeoutMs, token: await gcpTokenSource(kms.credentialsFile, { fetch: o.fetch }) })
}

/** Round-trip a random data key through the key manager (startup / preflight reachability check). */
export async function verifyKeyManager(km: KeyManager): Promise<void> {
  const probe = (await import('node:crypto')).randomBytes(32)
  const back = await km.unwrap(await km.wrap(probe))
  if (!back.equals(probe)) throw new AppError('kms_roundtrip_mismatch', `Key manager ${km.id} did not round-trip a data key`)
}
