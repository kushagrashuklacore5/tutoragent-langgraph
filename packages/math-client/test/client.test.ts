import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { configureLogging } from '@platform/observability'
import { createMathClient, normalizeResult, startMathSolver, venvPython, DEFAULT_SERVICE_DIR, type MathChecker, type MathSolverProcess } from '@platform/math-client'

configureLogging({ level: 'error' })
const installed = existsSync(venvPython(DEFAULT_SERVICE_DIR))
const skip = installed ? false : 'maths solver venv missing: run `python services/math-solver/setup_env.py`'

let svc: MathSolverProcess | undefined
let math: MathChecker

before(async () => {
  if (!installed) return
  svc = await startMathSolver({ workers: 2, timeoutSeconds: 1.5 })
  math = svc.client()
})
after(async () => { await svc?.stop() })

test('equivalence: symbolic, counterexample, assumptions', { skip }, async () => {
  const r = await math.equivalent('(x+1)^2', 'x^2+2*x+1')
  assert.equal(r.ok, true)
  assert.equal(r.method, 'symbolic')
  const bad = await math.equivalent('(x+1)^2', 'x^2+1')
  assert.deepEqual([bad.ok, bad.verdict, bad.reason], [false, 'fail', 'not_equivalent'])
  assert.ok(bad.counterexample?.at.x)
  assert.equal((await math.equivalent('sin(x)^2+cos(x)^2', '1')).ok, true)
  assert.equal((await math.equivalent('sqrt(x^2)', 'x')).ok, false)
  assert.equal((await math.equivalent('sqrt(x^2)', 'x', { assume: 'positive' })).ok, true)
  assert.equal((await math.equivalent('1/0', '1/0')).reason, 'undefined_expression')
})

test('checkSteps reports the first incorrect step', { skip }, async () => {
  const r = await math.checkSteps(['3*x - 5 = 10', '3*x = 15', 'x = 6'])
  assert.deepEqual([r.ok, r.verdict, r.firstBadStep], [false, 'fail', 2])
  assert.equal((await math.checkSteps(['(x+2)*(x-2)', 'x^2-4'])).ok, true)
})

test('numericCheck: tolerance and units', { skip }, async () => {
  assert.equal((await math.numericCheck({ expected: 'sqrt(2)', actual: 1.4142, tolerance: 1e-4 })).ok, true)
  assert.equal((await math.numericCheck({ expected: 1000, actual: 1011, tolerance: 0.01, relative: true })).reason, 'outside_tolerance')
  assert.equal((await math.numericCheck({ expected: 1.5, actual: 150, units: { expected: 'm', actual: 'cm' } })).ok, true)
  const mism = await math.numericCheck({ expected: 1, actual: 1, units: { expected: 'm', actual: 's' } })
  assert.deepEqual([mism.ok, mism.reason], [false, 'dimension_mismatch'])
})

test('evaluate and convertUnits', { skip }, async () => {
  const r = await math.evaluate('a*x^2 + b', { substitutions: { a: 2, x: 'sqrt(3)', b: 0.5 }, precision: 10 })
  assert.deepEqual([r.ok, r.exact, r.value], [true, '13/2', '6.500000000'])
  assert.equal((await math.convertUnits(36, 'km/h', 'm/s')).exact, '10')
})

test('malicious input is invalid, never ok', { skip }, async () => {
  for (const e of ["__import__('os').system('x')", 'x.__class__', '9**9**9', '(lambda: 1)()', 'x+'.repeat(400)]) {
    const r = await math.evaluate(e)
    assert.equal(r.ok, false, e)
    assert.equal(r.verdict, 'invalid', e)
  }
})

test('service-side timeout -> unverified, and the service recovers', { skip }, async () => {
  const r = await math.equivalent('(x+y+z+w+1)^12*sin(x)^2', '(x+y+z+w+1)^12*(1-cos(x)^2)')
  assert.deepEqual([r.ok, r.verdict, r.reason], [false, 'unverified', 'timeout'])
  const deadline = Date.now() + 60_000
  let after = await math.evaluate('2^10')
  while (after.verdict === 'unverified' && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 250))
    after = await math.evaluate('2^10')
  }
  assert.equal(after.exact, '1024')
})

test('client deadline -> unverified (server that never answers)', async () => {
  const sockets = new Set<import('node:net').Socket>()
  const hang = http.createServer(() => { /* never respond */ })
  hang.on('connection', (s) => sockets.add(s))
  await new Promise<void>((r) => hang.listen(0, '127.0.0.1', r))
  const { port } = hang.address() as AddressInfo
  try {
    const c = createMathClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 200 })
    const t0 = Date.now()
    const r = await c.equivalent('x', 'x')
    assert.deepEqual([r.ok, r.verdict, r.reason], [false, 'unverified', 'timeout'])
    assert.ok(Date.now() - t0 < 2000)
  } finally {
    for (const s of sockets) s.destroy()
    await new Promise((r) => hang.close(r))
  }
})

test('unreachable service -> unverified', async () => {
  const probe = http.createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address() as AddressInfo
  await new Promise((r) => probe.close(r)) // now nothing listens on this port
  const c = createMathClient({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 2000 })
  const r = await c.checkSteps(['x', 'x'])
  assert.deepEqual([r.ok, r.verdict, r.reason], [false, 'unverified', 'unavailable'])
  assert.equal(await c.healthy(), false)
})

test('malformed or inconsistent responses fail closed', async () => {
  assert.equal(normalizeResult(null).verdict, 'unverified')
  assert.equal(normalizeResult({ ok: true, verdict: 'fail', reason: 'x' }).verdict, 'unverified')
  assert.equal(normalizeResult({ ok: true, verdict: 'maybe', reason: 'x' }).verdict, 'unverified')
  assert.equal(normalizeResult({ ok: 'yes', verdict: 'pass', reason: 'x' }).ok, false)
  assert.equal(normalizeResult({ ok: true, verdict: 'pass', reason: 'equivalent' }).ok, true)

  const liar = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"verdict":"fail","reason":"x"}') })
  await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r))
  try {
    const c = createMathClient({ baseUrl: `http://127.0.0.1:${(liar.address() as AddressInfo).port}` })
    const r = await c.equivalent('x', 'y')
    assert.deepEqual([r.ok, r.reason], [false, 'bad_response'])
  } finally {
    await new Promise((r) => liar.close(r))
  }
})

test('client refuses non-loopback hosts unless allowed', () => {
  assert.throws(() => createMathClient({ baseUrl: 'http://example.com:8765' }))
  assert.throws(() => createMathClient({ baseUrl: 'https://127.0.0.1:8765' }))
  assert.doesNotThrow(() => createMathClient({ baseUrl: 'http://math-solver:8765', allowRemote: true }))
})
