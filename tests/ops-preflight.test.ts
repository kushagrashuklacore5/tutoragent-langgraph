import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { migrate } from '@platform/tenancy-db'
import { createTestDatabase, type TestDatabase } from '@platform/tenancy-db/testing'
import { migrationSetsFor } from '@platform/module-runtime'
import { configureLogging } from '@platform/observability'
import { runPreflight, formatReport, type PreflightReport } from '../tooling/preflight.ts'

const root = resolve(import.meta.dirname, '..')
let t: TestDatabase
let env: NodeJS.ProcessEnv
const status = (r: PreflightReport, id: string) => r.checks.find((c) => c.id === id)?.status

before(async () => {
  if (!process.env.TEST_VERBOSE) configureLogging({ level: 'error', sink: () => undefined })
  t = await createTestDatabase('pf')
  await migrate(t.ownerUrl, migrationSetsFor([]))
  env = { PLATFORM_ENV: 'test', DATABASE_URL: t.ownerUrl, APP_DATABASE_URL: t.appUrl, SYSTEM_DATABASE_URL: t.systemUrl, PLATFORM_MASTER_KEY: randomBytes(32).toString('base64') }
})
after(() => t.drop())

test('preflight passes on a correctly migrated database (dev rules)', async () => {
  const r = await runPreflight({ env, modules: [] })
  assert.equal(r.ok, true, formatReport(r))
  for (const id of ['env.load', 'db.connect', 'db.migrations', 'db.rls', 'db.roles', 'db.audit', 'kms', 'mail', 'modules.manifests']) assert.equal(status(r, id), 'pass', `${id}\n${formatReport(r)}`)
  assert.equal(status(r, 'tls'), 'warn') // http + no sslmode is only a warning outside production
  assert.equal(status(r, 'env.production'), 'skip')
})

test('preflight fails a deliberately misconfigured database and environment', async () => {
  const c = new pg.Client({ connectionString: t.ownerUrl })
  await c.connect()
  const dir = mkdtempSync(join(tmpdir(), 'pf-'))
  try {
    await c.query('create table public.leaky (id int, tenant_id uuid)') // tenant table without RLS
    await c.query('alter table public.leaky owner to platform_app') // app role owns a table
    await c.query('grant update on platform.audit_events to platform_app') // audit no longer append-only
    writeFileSync(join(dir, '0001_new.sql'), 'select 1;')
    const r = await runPreflight({ env, modules: [], extraMigrationSets: [{ owner: 'test.pending', schema: 'test_pending', dir }] })
    assert.equal(r.ok, false)
    assert.equal(status(r, 'db.rls'), 'fail')
    assert.match(r.checks.find((x) => x.id === 'db.rls')!.details.join(), /public\.leaky: rls_disabled/)
    assert.equal(status(r, 'db.roles'), 'fail')
    assert.match(r.checks.find((x) => x.id === 'db.roles')!.details.join(), /owns 1 table/)
    assert.equal(status(r, 'db.audit'), 'fail')
    assert.match(r.checks.find((x) => x.id === 'db.audit')!.details.join(), /platform_app has UPDATE/)
    assert.equal(status(r, 'db.migrations'), 'fail')
    assert.match(r.checks.find((x) => x.id === 'db.migrations')!.details.join(), /pending: test\.pending\/0001_new\.sql/)

    // production rules on a dev configuration: everything that is unsafe is named
    const p = await runPreflight({ env: { ...env, METRICS_TOKEN: 'short' }, modules: [], production: true })
    for (const id of ['env.production', 'tls', 'mail', 'documents', 'kms']) assert.equal(status(p, id), 'fail', `${id}\n${formatReport(p)}`)
    const prodDetails = p.checks.find((x) => x.id === 'env.production')!.details.join('\n')
    assert.match(prodDetails, /KMS_PROVIDER must be aws or gcp/)
    assert.match(prodDetails, /PUBLIC_BASE_URL must be https/)
    assert.match(prodDetails, /METRICS_TOKEN must be at least 24/)
    assert.ok(!JSON.stringify(p).includes(env.PLATFORM_MASTER_KEY!), 'report never contains secrets')

    // CLI: JSON output and non-zero exit
    const cli = await run(['tooling/preflight.ts', '--json'], env)
    assert.equal(cli.code, 1)
    const json = JSON.parse(cli.stdout) as PreflightReport
    assert.equal(json.ok, false)
    const human = await run(['tooling/preflight.ts'], env)
    assert.equal(human.code, 1)
    assert.match(human.stdout, /\[FAIL\] Row-level security/)
  } finally {
    await c.query('drop table if exists public.leaky')
    await c.query('revoke update on platform.audit_events from platform_app')
    await c.end()
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal((await runPreflight({ env, modules: [] })).ok, true, 'fixing the problems makes preflight pass again')
})

test('preflight reports missing environment and unreachable databases', async () => {
  const r = await runPreflight({ env: { PLATFORM_ENV: 'test' }, modules: [] })
  assert.equal(r.ok, false)
  assert.equal(status(r, 'env.load'), 'fail')
  const bad = await runPreflight({ env: { ...env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/x' }, modules: [] })
  assert.equal(status(bad, 'db.connect'), 'fail')
  assert.equal(status(bad, 'db.rls'), 'skip')
})

// ───────────── production startup (fail-closed) ─────────────
function run(args: string[], e: NodeJS.ProcessEnv, opts: { until?: RegExp; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; kill: () => void }> {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...e }, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const done = (code: number | null) => resolveP({ code, stdout, stderr, kill: () => child.kill() })
    const timer = setTimeout(() => { child.kill(); done(null) }, opts.timeoutMs ?? 30_000)
    child.stdout.on('data', (d) => {
      stdout += d
      if (opts.until?.test(stdout)) { clearTimeout(timer); done(null) }
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('exit', (code) => { clearTimeout(timer); done(code) })
  })
}
const freePort = () => new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => r(p)) }) })

test('production startup refuses an unsafe configuration (api and worker)', async () => {
  for (const host of ['apps/api/src/main.ts', 'apps/worker/src/main.ts']) {
    const r = await run([host], { ...env, PLATFORM_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost:8080' })
    assert.notEqual(r.code, 0, host)
    assert.match(r.stderr, /Refusing to start in production/, host)
    assert.match(r.stderr, /KMS_PROVIDER must be aws or gcp/)
    assert.match(r.stderr, /METRICS_TOKEN is required/)
    assert.ok(!r.stderr.includes(env.PLATFORM_MASTER_KEY!))
  }
})

test('production startup succeeds with cloud KMS, SMTP, https, metrics token and separate roles; refuses a missing mail transport', async () => {
  // minimal AWS KMS stand-in (signature verification is covered by packages/ai-gateway/test/kms.test.ts)
  const kms = http.createServer((req, res) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      const body = JSON.parse(b)
      const out = req.headers['x-amz-target'] === 'TrentService.Encrypt' ? { CiphertextBlob: Buffer.from('wrapped:' + body.Plaintext).toString('base64') }
        : { Plaintext: Buffer.from(body.CiphertextBlob, 'base64').toString().slice('wrapped:'.length) }
      res.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' }).end(JSON.stringify(out))
    })
  })
  await new Promise<void>((r) => kms.listen(0, '127.0.0.1', r))
  const port = await freePort()
  const prodEnv = {
    DATABASE_URL: t.ownerUrl, APP_DATABASE_URL: t.appUrl, SYSTEM_DATABASE_URL: t.systemUrl,
    PLATFORM_ENV: 'production', PORT: String(port), PUBLIC_BASE_URL: 'https://app.example.in', ALLOWED_ORIGINS: 'https://app.example.in',
    METRICS_TOKEN: randomBytes(24).toString('base64url'),
    KMS_PROVIDER: 'aws', KMS_AWS_REGION: 'ap-south-1', KMS_AWS_KEY_ID: 'alias/ekb-test', KMS_AWS_ENDPOINT: `http://127.0.0.1:${(kms.address() as AddressInfo).port}`,
    AWS_ACCESS_KEY_ID: 'AKIATEST', AWS_SECRET_ACCESS_KEY: 'test-secret-key-value',
    MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.in', SMTP_USER: 'u', SMTP_PASSWORD: 'p-password', MAIL_FROM: 'Ek Bharat <no-reply@example.in>',
    DOCUMENTS_ENABLED: 'false', LOG_LEVEL: 'info',
  }
  try {
    const noMail = await run(['apps/api/src/main.ts'], { ...prodEnv, MAIL_TRANSPORT: '' })
    assert.notEqual(noMail.code, 0)
    assert.match(noMail.stderr, /mail_not_configured|MAIL_TRANSPORT/)
    const noScanner = await run(['apps/api/src/main.ts'], { ...prodEnv, DOCUMENTS_ENABLED: 'true', DOCUMENT_SCANNER: 'dev-noop' })
    assert.notEqual(noScanner.code, 0)
    assert.match(noScanner.stderr, /no-op document scanner is not allowed in production/)

    const ok = await run(['apps/api/src/main.ts'], prodEnv, { until: /api listening/ })
    try {
      assert.match(ok.stdout, /"keyManager":"aws-kms:ap-south-1:alias\/ekb-test"/, ok.stderr)
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(health.status, 200)
      assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`)).status, 401) // token required in production
      assert.ok(!ok.stdout.includes('test-secret-key-value') && !ok.stdout.includes(prodEnv.METRICS_TOKEN))
    } finally {
      ok.kill()
    }
    // the same environment passes the full preflight under production rules except TLS to the DB (local cluster has no TLS)
    await migrate(t.ownerUrl, migrationSetsFor([])) // platform migrations may have been added since before()
    const pf = await runPreflight({ env: prodEnv, modules: [] })
    assert.deepEqual(pf.checks.filter((c) => c.status === 'fail').map((c) => c.id), ['tls'], formatReport(pf))
  } finally {
    kms.close()
  }
})
