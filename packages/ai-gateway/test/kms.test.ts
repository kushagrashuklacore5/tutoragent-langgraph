import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCipheriv, createDecipheriv, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '@platform/core'
import { configureLogging, logger } from '@platform/observability'
import {
  signV4, awsKmsKeyManager, staticAwsCredentials, awsCredentialChain, gcpKmsKeyManager, serviceAccountTokenSource, metadataTokenSource,
  crc32c, keyManagerFromConfig, verifyKeyManager, type KeyManager,
} from '../src/index.ts'

// ─────────────── SigV4: AWS published test-suite values ───────────────
// Source: AWS Signature Version 4 test suite ("aws-sig-v4-test-suite", also shipped as
// awslabs/aws-c-auth tests/aws-signing-test-suite/v4/{get-vanilla,post-vanilla,get-vanilla-query-order-key-case}),
// and the IAM ListUsers example from the AWS General Reference "Signature Version 4 signing process".
// Credentials AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY, 2015-08-30T12:36:00Z, us-east-1.
const SUITE_CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }
const SUITE_DATE = new Date('2015-08-30T12:36:00Z')

test('SigV4 reproduces the AWS test-suite signatures exactly', () => {
  const get = signV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '' }, SUITE_CREDS, 'us-east-1', 'service', SUITE_DATE)
  assert.equal(get.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(get.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63')
  assert.equal(get.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  assert.equal(get.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31')
  assert.equal(signV4({ method: 'POST', url: 'https://example.amazonaws.com/', headers: {}, body: '' }, SUITE_CREDS, 'us-east-1', 'service', SUITE_DATE).signature,
    '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b')
  assert.equal(signV4({ method: 'GET', url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1', headers: {}, body: '' }, SUITE_CREDS, 'us-east-1', 'service', SUITE_DATE).signature,
    'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500')
  const iam = signV4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '' }, SUITE_CREDS, 'us-east-1', 'iam', SUITE_DATE)
  assert.equal(iam.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7')
  // session token is signed when present
  assert.match(signV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '' }, { ...SUITE_CREDS, sessionToken: 'tok' }, 'us-east-1', 'service', SUITE_DATE).authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token,/)
})

test('CRC32C matches the standard check value', () => {
  assert.equal(crc32c(Buffer.from('123456789')), 0xe3069283)
  assert.equal(crc32c(Buffer.alloc(0)), 0)
})

// ─────────────── helpers ───────────────
type Handler = (req: http.IncomingMessage, body: string) => { status: number; json?: unknown; text?: string; headers?: Record<string, string>; hang?: boolean }
const servers: http.Server[] = []
after(() => { for (const s of servers) { s.closeAllConnections(); s.close() } })
async function serve(h: Handler): Promise<string> {
  const s = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const r = h(req, body)
      if (r.hang) return // never respond: exercise client timeouts
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }).end(r.text ?? (r.json === undefined ? '' : JSON.stringify(r.json)))
    })
  })
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
const captured: string[] = []
configureLogging({ level: 'debug', sink: (l) => captured.push(l) })
const noSecrets = (err: unknown, ...secrets: string[]) => {
  const text = `${(err as Error).message} ${JSON.stringify(err)} ${JSON.stringify((err as { details?: unknown }).details ?? {})}`
  for (const s of secrets) assert.ok(!text.includes(s), `error leaks ${s.slice(0, 4)}…`)
}

// ─────────────── mock AWS KMS (verifies SigV4 server-side) ───────────────
const AWS_SECRET = 'mockSecretKey/' + randomBytes(12).toString('base64url')
const AWS_TOKEN = 'mockSessionToken-' + randomBytes(12).toString('hex')
const KEY_ARN = 'arn:aws:kms:ap-south-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab'
const awsMaster = randomBytes(32)

function mockAwsKms(opts: { throttleFirst?: number; hang?: boolean } = {}) {
  let throttle = opts.throttleFirst ?? 0
  const calls: { target: string; body: any }[] = []
  const url = serve((req, raw) => {
    if (opts.hang) return { status: 200, hang: true }
    const auth = String(req.headers.authorization ?? '')
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/kms\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth)
    if (!m || m[1] !== 'AKIAMOCK' || m[3] !== 'ap-south-1') return { status: 400, json: { __type: 'UnrecognizedClientException', message: 'bad credential scope' } }
    const signed: Record<string, string> = {}
    for (const h of m[4]!.split(';')) signed[h] = String(req.headers[h])
    const d = String(req.headers['x-amz-date'])
    const when = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`)
    const expect = signV4({ method: req.method!, url: `http://${req.headers.host}${req.url}`, headers: signed, body: raw }, { accessKeyId: 'AKIAMOCK', secretAccessKey: AWS_SECRET, sessionToken: AWS_TOKEN }, 'ap-south-1', 'kms', when)
    if (expect.signature !== m[5]) return { status: 400, json: { __type: 'InvalidSignatureException', message: 'The request signature we calculated does not match' } }
    if (req.headers['x-amz-security-token'] !== AWS_TOKEN || !m[4]!.includes('x-amz-target')) return { status: 400, json: { __type: 'UnrecognizedClientException' } }
    const target = String(req.headers['x-amz-target'])
    const body = JSON.parse(raw)
    calls.push({ target, body })
    if (throttle-- > 0) return { status: 400, json: { __type: 'com.amazonaws.kms#ThrottlingException', message: 'Rate exceeded' } }
    const ctx = JSON.stringify(body.EncryptionContext ?? {})
    if (target === 'TrentService.Encrypt') {
      if (body.KeyId !== KEY_ARN) return { status: 400, json: { __type: 'NotFoundException', message: 'key not found' } }
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', awsMaster, iv)
      c.setAAD(Buffer.from(ctx))
      const ct = Buffer.concat([c.update(Buffer.from(body.Plaintext, 'base64')), c.final()])
      return { status: 200, json: { CiphertextBlob: Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64'), KeyId: KEY_ARN, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' } }
    }
    if (target === 'TrentService.Decrypt') {
      try {
        const blob = Buffer.from(body.CiphertextBlob, 'base64')
        const d2 = createDecipheriv('aes-256-gcm', awsMaster, blob.subarray(0, 12))
        d2.setAAD(Buffer.from(ctx))
        d2.setAuthTag(blob.subarray(12, 28))
        const pt = Buffer.concat([d2.update(blob.subarray(28)), d2.final()])
        return { status: 200, json: { Plaintext: pt.toString('base64'), KeyId: KEY_ARN } }
      } catch {
        return { status: 400, json: { __type: 'InvalidCiphertextException' } }
      }
    }
    return { status: 400, json: { __type: 'UnknownOperationException' } }
  })
  return { url, calls }
}
const awsCreds = staticAwsCredentials({ accessKeyId: 'AKIAMOCK', secretAccessKey: AWS_SECRET, sessionToken: AWS_TOKEN })

test('AWS KMS: wrap/unwrap round trip with SigV4 verified by the mock, encryption context bound', async () => {
  const kms = mockAwsKms()
  const km = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: await kms.url, credentials: awsCreds })
  assert.equal(km.id, `aws-kms:ap-south-1:${KEY_ARN}`)
  const dk = randomBytes(32)
  const wrapped = await km.wrap(dk)
  assert.ok(!wrapped.includes(dk))
  assert.deepEqual(await km.unwrap(wrapped), dk)
  assert.deepEqual(kms.calls.map((c) => c.target), ['TrentService.Encrypt', 'TrentService.Decrypt'])
  assert.deepEqual(kms.calls[0]!.body.EncryptionContext, { purpose: 'ekbharat/ai-data-key' })
  assert.equal(kms.calls[1]!.body.KeyId, KEY_ARN)
  await verifyKeyManager(km)

  // a different encryption context cannot unwrap
  const other = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: await kms.url, credentials: awsCreds, encryptionContext: { purpose: 'other' } })
  await assert.rejects(other.unwrap(wrapped), (e: any) => e.code === 'kms_unwrap_failed' && /InvalidCiphertextException/.test(e.message))
})

test('AWS KMS: errors are typed, throttling is retried, credentials never appear in errors or logs', async () => {
  const kms = mockAwsKms({ throttleFirst: 2 })
  const km = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: await kms.url, credentials: awsCreds, baseDelayMs: 1 })
  const w = await km.wrap(randomBytes(32))
  assert.equal(kms.calls.length, 3) // 2 throttled + 1 success

  const wrongSecret = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: await kms.url, credentials: staticAwsCredentials({ accessKeyId: 'AKIAMOCK', secretAccessKey: 'wrong-secret-value-123', sessionToken: AWS_TOKEN }) })
  const err = await wrongSecret.unwrap(w).catch((e) => e)
  assert.equal(err.code, 'kms_access_denied')
  assert.match(err.message, /aws KMS Decrypt failed: HTTP 400 InvalidSignatureException/)
  noSecrets(err, AWS_SECRET, AWS_TOKEN, 'wrong-secret-value-123')

  const missingKey = awsKmsKeyManager({ region: 'ap-south-1', keyId: 'alias/nope', endpoint: await kms.url, credentials: awsCreds })
  await assert.rejects(missingKey.wrap(randomBytes(32)), (e: any) => e.code === 'kms_error' && /NotFoundException/.test(e.message))
  await assert.rejects(km.unwrap(randomBytes(60)), (e: any) => e.code === 'kms_unwrap_failed')

  // logging an error object or the credentials themselves is redacted (secrets registered with the redactor)
  captured.length = 0
  logger.error('kms failed', { err, detail: `secret=${AWS_SECRET} token ${AWS_TOKEN}` })
  assert.ok(!captured.join().includes(AWS_SECRET) && !captured.join().includes(AWS_TOKEN))
})

test('AWS KMS: timeouts and unreachable endpoints fail closed with kms_unavailable', async () => {
  const hang = mockAwsKms({ hang: true })
  const km = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: await hang.url, credentials: awsCreds, timeoutMs: 50, maxAttempts: 2, baseDelayMs: 1 })
  const t0 = Date.now()
  await assert.rejects(km.wrap(randomBytes(32)), (e: any) => e.code === 'kms_unavailable' && /timeout after 2 attempt/.test(e.message))
  assert.ok(Date.now() - t0 < 2000)
  const dead = awsKmsKeyManager({ region: 'ap-south-1', keyId: KEY_ARN, endpoint: 'http://127.0.0.1:9', credentials: awsCreds, maxAttempts: 1 })
  await assert.rejects(dead.wrap(randomBytes(32)), (e: any) => e.code === 'kms_unavailable')
})

test('AWS credential chain: env, container credentials endpoint, IMDSv2', async () => {
  const fromEnv = await awsCredentialChain({ AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 'envsecretvalue123' })()
  assert.equal(fromEnv.accessKeyId, 'AKIAENV')

  let containerCalls = 0
  const container = await serve((req) => {
    containerCalls++
    if (req.headers.authorization !== 'ctr-token') return { status: 401 }
    return { status: 200, json: { AccessKeyId: 'AKIACTR', SecretAccessKey: 'ctrsecret-abcdef', Token: 'ctr-session', Expiration: new Date(Date.now() + 3600_000).toISOString() } }
  })
  const ctr = awsCredentialChain({ AWS_CONTAINER_CREDENTIALS_FULL_URI: `${container}/creds`, AWS_CONTAINER_AUTHORIZATION_TOKEN: 'ctr-token' })
  assert.equal((await ctr()).accessKeyId, 'AKIACTR')
  await ctr()
  assert.equal(containerCalls, 1, 'credentials are cached until near expiry')

  const imds = await serve((req) => {
    if (req.method === 'PUT' && req.url === '/latest/api/token') return { status: 200, text: 'imds-token' }
    if (req.headers['x-aws-ec2-metadata-token'] !== 'imds-token') return { status: 401 }
    if (req.url === '/latest/meta-data/iam/security-credentials/') return { status: 200, text: 'app-role\n' }
    if (req.url === '/latest/meta-data/iam/security-credentials/app-role') return { status: 200, json: { AccessKeyId: 'AKIAIMDS', SecretAccessKey: 'imdssecret-123456', Token: 't' } }
    return { status: 404 }
  })
  assert.equal((await awsCredentialChain({}, { imdsEndpoint: imds })()).accessKeyId, 'AKIAIMDS')
  await assert.rejects(awsCredentialChain({}, { imdsEndpoint: 'http://127.0.0.1:9', timeoutMs: 200 })(), (e: any) => /instance metadata unreachable/.test(e.message))
})

// ─────────────── mock Google Cloud KMS + OAuth2 token endpoint ───────────────
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const KEY_NAME = 'projects/ekb-test/locations/asia-south1/keyRings/platform/cryptoKeys/ai-data-keys'
const gcpMaster = randomBytes(32)

async function mockGcp(opts: { failFirst?: number } = {}) {
  let fail = opts.failFirst ?? 0
  const tokens = new Set<string>()
  const seen: { path: string; body: any }[] = []
  const url = await serve((req, raw) => {
    if (req.url === '/token') {
      const p = new URLSearchParams(raw)
      if (p.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { status: 400, json: { error: 'unsupported_grant_type' } }
      const [h, c, s] = p.get('assertion')!.split('.')
      const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s!, 'base64url'))
      const header = JSON.parse(Buffer.from(h!, 'base64url').toString())
      const claims = JSON.parse(Buffer.from(c!, 'base64url').toString())
      const now = Date.now() / 1000
      if (!ok || header.alg !== 'RS256' || claims.iss !== 'kms-user@ekb-test.iam.gserviceaccount.com' || claims.scope !== 'https://www.googleapis.com/auth/cloudkms' ||
        claims.aud !== `${urlRef.value}/token` || claims.exp - claims.iat !== 3600 || Math.abs(claims.iat - now) > 60) return { status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }
      const t = 'ya29.mock-' + randomBytes(16).toString('hex')
      tokens.add(t)
      return { status: 200, json: { access_token: t, expires_in: 3599, token_type: 'Bearer' } }
    }
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '')
    if (!tokens.has(bearer)) return { status: 401, json: { error: { code: 401, status: 'UNAUTHENTICATED' } } }
    if (fail-- > 0) return { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE' } } }
    const body = JSON.parse(raw)
    seen.push({ path: req.url!, body })
    const aad = Buffer.from(body.additionalAuthenticatedData ?? '', 'base64')
    if (req.url === `/v1/${KEY_NAME}:encrypt`) {
      const pt = Buffer.from(body.plaintext, 'base64')
      if (body.plaintextCrc32c !== String(crc32c(pt))) return { status: 400, json: { error: { status: 'INVALID_ARGUMENT' } } }
      const iv = randomBytes(12)
      const ci = createCipheriv('aes-256-gcm', gcpMaster, iv)
      ci.setAAD(aad)
      const ct = Buffer.concat([iv, Buffer.alloc(16), ci.update(pt), ci.final()])
      ci.getAuthTag().copy(ct, 12)
      return { status: 200, json: { name: `${KEY_NAME}/cryptoKeyVersions/1`, ciphertext: ct.toString('base64'), ciphertextCrc32c: String(crc32c(ct)), verifiedPlaintextCrc32c: true, verifiedAdditionalAuthenticatedDataCrc32c: true } }
    }
    if (req.url === `/v1/${KEY_NAME}:decrypt`) {
      const ct = Buffer.from(body.ciphertext, 'base64')
      if (body.ciphertextCrc32c !== String(crc32c(ct))) return { status: 400, json: { error: { status: 'INVALID_ARGUMENT' } } }
      try {
        const d = createDecipheriv('aes-256-gcm', gcpMaster, ct.subarray(0, 12))
        d.setAAD(aad)
        d.setAuthTag(ct.subarray(12, 28))
        const pt = Buffer.concat([d.update(ct.subarray(28)), d.final()])
        return { status: 200, json: { plaintext: pt.toString('base64'), plaintextCrc32c: String(crc32c(pt)) } }
      } catch {
        return { status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Decryption failed' } } }
      }
    }
    return { status: 404, json: { error: { status: 'NOT_FOUND' } } }
  })
  const urlRef = { value: url }
  return { url, seen }
}
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const sa = (url: string) => ({ type: 'service_account', client_email: 'kms-user@ekb-test.iam.gserviceaccount.com', private_key: PEM, private_key_id: 'kid1', token_uri: `${url}/token` })

test('GCP KMS: OAuth2 JWT bearer (RS256) + encrypt/decrypt round trip with CRC32C and AAD', async () => {
  const g = await mockGcp()
  const km = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: g.url, token: serviceAccountTokenSource(sa(g.url)) })
  assert.equal(km.id, `gcp-kms:${KEY_NAME}`)
  const dk = randomBytes(32)
  const w = await km.wrap(dk)
  assert.deepEqual(await km.unwrap(w), dk)
  assert.equal(g.seen[0]!.path, `/v1/${KEY_NAME}:encrypt`)
  assert.equal(Buffer.from(g.seen[0]!.body.additionalAuthenticatedData, 'base64').toString(), 'ekbharat/ai-data-key')
  const otherAad = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: g.url, token: serviceAccountTokenSource(sa(g.url)), additionalAuthenticatedData: 'x' })
  await assert.rejects(otherAad.unwrap(w), (e: any) => e.code === 'kms_unwrap_failed')
  await verifyKeyManager(km)
})

test('GCP KMS: transient 503 retried; bad signature key → access denied without leaking key or token', async () => {
  const g = await mockGcp({ failFirst: 1 })
  const km = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: g.url, token: serviceAccountTokenSource(sa(g.url)), baseDelayMs: 1 })
  await km.wrap(randomBytes(32))
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const bad = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: g.url, token: serviceAccountTokenSource({ ...sa(g.url), private_key: wrongKey }) })
  const err = await bad.wrap(randomBytes(32)).catch((e) => e)
  assert.equal(err.code, 'kms_access_denied')
  assert.match(err.message, /gcp KMS token failed: HTTP 400 invalid_grant/)
  noSecrets(err, wrongKey.slice(40, 90), PEM.slice(40, 90))
  captured.length = 0
  logger.error('x', { err, sa: sa(g.url) })
  assert.ok(!captured.join().includes(PEM.slice(40, 90)), 'private key never logged')
  assert.throws(() => gcpKmsKeyManager({ keyName: 'projects/x/keys/y', token: async () => 't' }), /keyName must be/)
})

test('GCP KMS: integrity mismatch and timeouts fail closed', async () => {
  const liar = await serve(() => ({ status: 200, json: { ciphertext: Buffer.from('abc').toString('base64'), ciphertextCrc32c: '1', verifiedPlaintextCrc32c: true, verifiedAdditionalAuthenticatedDataCrc32c: true } }))
  const km = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: liar, token: async () => 'tok-abcdefgh' })
  await assert.rejects(km.wrap(randomBytes(32)), (e: any) => e.code === 'kms_integrity')
  const hang = await serve(() => ({ status: 200, hang: true }))
  const slow = gcpKmsKeyManager({ keyName: KEY_NAME, endpoint: hang, token: async () => 'tok-abcdefgh', timeoutMs: 50, maxAttempts: 2, baseDelayMs: 1 })
  await assert.rejects(slow.unwrap(randomBytes(40)), (e: any) => e.code === 'kms_unavailable')
})

test('GCP metadata-server token source', async () => {
  const md = await serve((req) => req.headers['metadata-flavor'] === 'Google' && req.url!.startsWith('/computeMetadata/v1/instance/service-accounts/default/token')
    ? { status: 200, json: { access_token: 'ya29.md-token-xyz', expires_in: 3000 } } : { status: 403 })
  assert.equal(await metadataTokenSource({ metadataHost: md })(), 'ya29.md-token-xyz')
})

// ─────────────── factory ───────────────
test('factory: local refused in production; aws/gcp built from config; credentials from env/file', async () => {
  const base = { DATABASE_URL: 'postgres://o@h/d', APP_DATABASE_URL: 'postgres://a@h/d', PLATFORM_MASTER_KEY: randomBytes(32).toString('base64') }
  const local = loadConfig(base)
  await assert.rejects(keyManagerFromConfig(local.kms, { env: 'production', masterKey: local.masterKey }), (e: any) => e.code === 'kms_local_in_production')
  const lkm = await keyManagerFromConfig(local.kms, { env: 'development', masterKey: local.masterKey })
  await verifyKeyManager(lkm)

  const kms = mockAwsKms()
  const awsCfg = loadConfig({ DATABASE_URL: base.DATABASE_URL, APP_DATABASE_URL: base.APP_DATABASE_URL, KMS_PROVIDER: 'aws', KMS_AWS_KEY_ID: KEY_ARN, KMS_AWS_ENDPOINT: await kms.url })
  assert.deepEqual(awsCfg.masterKey.length, 0, 'no master key needed with a cloud KMS')
  assert.equal(awsCfg.kms.provider === 'aws' && awsCfg.kms.region, 'ap-south-1')
  const akm = await keyManagerFromConfig(awsCfg.kms, { env: 'production', processEnv: { AWS_ACCESS_KEY_ID: 'AKIAMOCK', AWS_SECRET_ACCESS_KEY: AWS_SECRET, AWS_SESSION_TOKEN: AWS_TOKEN } })
  await verifyKeyManager(akm)

  const g = await mockGcp()
  const dir = mkdtempSync(join(tmpdir(), 'kms-'))
  try {
    writeFileSync(join(dir, 'sa.json'), JSON.stringify(sa(g.url)))
    const gcpCfg = loadConfig({ ...base, PLATFORM_MASTER_KEY: '', KMS_PROVIDER: 'gcp', KMS_GCP_KEY_NAME: KEY_NAME, KMS_GCP_ENDPOINT: g.url, GOOGLE_APPLICATION_CREDENTIALS: join(dir, 'sa.json') })
    const gkm: KeyManager = await keyManagerFromConfig(gcpCfg.kms, { env: 'production' })
    await verifyKeyManager(gkm)
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    await assert.rejects(keyManagerFromConfig({ provider: 'gcp', keyName: KEY_NAME, credentialsFile: join(dir, 'bad.json') }, { env: 'production' }), (e: any) => e.code === 'kms_config_invalid')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.throws(() => loadConfig({ ...base, KMS_PROVIDER: 'gcp', KMS_GCP_KEY_NAME: 'nope' }), /KMS_GCP_KEY_NAME/)
  assert.throws(() => loadConfig({ ...base, KMS_PROVIDER: 'vault' }), /KMS_PROVIDER/)
  assert.throws(() => loadConfig({ ...base, KMS_PROVIDER: 'aws' }), /KMS_AWS_KEY_ID/)
})
