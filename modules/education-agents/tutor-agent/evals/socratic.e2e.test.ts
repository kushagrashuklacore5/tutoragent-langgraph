import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setupTestDb, type PlatformTestDb } from '@platform/testing'
import { aiGatewayMigrations } from '@platform/ai-gateway'

/**
 * End-to-end PIPELINE test of the `tutor/socratic` suite: the real eval CLI (tooling/evals.ts) runs
 * every case through the real gateway (routing, schema validation, metering in Postgres) with the
 * deterministic fake adapter and the Tutor's real orchestration code. It proves the evaluation
 * machinery works and catches a misbehaving model; it is NOT evidence of any model's quality.
 */

const root = resolve(import.meta.dirname, '../../../..')
const routes = resolve(import.meta.dirname, 'routes')
let t: PlatformTestDb
let out: string
const env = () => ({ ...process.env, SYSTEM_DATABASE_URL: t.test.systemUrl, PLATFORM_MASTER_KEY: randomBytes(32).toString('base64'), LOG_LEVEL: 'error' })

function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [join(root, 'tooling/evals.ts'), ...args], { cwd: root, env: env(), encoding: 'utf8', timeout: 180_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}
const report = (dir: string) => JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))

before(async () => {
  t = await setupTestDb([aiGatewayMigrations])
  out = mkdtempSync(join(tmpdir(), 'tutor-evals-'))
})
after(async () => {
  if (!process.env.KEEP_EVAL_OUTPUT) rmSync(out, { recursive: true, force: true })
  else console.log(`eval output kept in ${out}`)
  await t.close()
})

test('suite is discoverable', () => {
  const r = cli('list')
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /tutor\/socratic .*graded_mode_leaks == 0/)
})

test('well-behaved scripted tutor: all gates pass, report is reproducible and honest about the fake adapter; no standing for fakes', async () => {
  const r = cli('run', 'tutor/socratic', '--route', join(routes, 'fake.json'), '--split', 'all', '--out', join(out, 'good'), '--record-standing')
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /PASS tutor\/socratic/)
  assert.match(r.stdout, /not recorded \(adapter fake is a test adapter\)/)
  const rep = report(join(out, 'good'))
  assert.equal(rep.passed, true)
  assert.equal(rep.summary.attempted, 18)
  assert.equal(rep.summary.errors, 0)
  assert.equal(rep.metrics.no_premature_answer.value, 1)
  assert.equal(rep.metrics.graded_mode_leaks.value, 0)
  assert.equal(rep.metrics.not_in_material_honesty.value, 1)
  // the orchestrator took the scripted teaching moves (ask / hint / worked_solution / rescue_probe)
  assert.equal(rep.metrics.orchestrator_move.value, 1)
  assert.ok(rep.metrics.p95_latency_ms.value > 0)
  assert.ok(rep.cost.totalMicros > 0, 'cost comes from gateway metering')
  assert.equal(rep.cost.currency, 'INR')
  assert.ok(rep.byTag.hi && rep.byTag.hinglish && rep.byTag.graded)
  const rp = rep.reproducibility
  assert.match(rp.datasetVersion, /^[0-9a-f]{64}$/)
  assert.equal(rp.promptVersions['education.tutor.socratic_turn'], 'socratic_turn@4')
  assert.equal(rp.routes[0].adapter, 'fake')
  assert.equal(rp.routes[0].modelId, 'scripted-tutor')
  assert.equal(rp.tasks[0].id, 'education.tutor.socratic_turn')
  assert.match(rep.notes.join(), /NOT evidence of model quality/)
  assert.match(readFileSync(join(out, 'good', 'report.md'), 'utf8'), /\*\*PASS\*\*/)
  const standings = await t.system.query('select * from platform.ai_eval_standings')
  assert.equal(standings.rows.length, 0)
  const ops = await t.system.query<{ n: number }>(`select count(*)::int as n from platform.ai_operations where task_id = 'education.tutor.socratic_turn' and status = 'ok'`)
  assert.equal(ops.rows[0]!.n, rep.cases.reduce((a: number, c: { calls: unknown[] }) => a + c.calls.length, 0))
})

test('a leaky model fails the gates (graded-mode leaks, premature answers) and the baseline regression rule', () => {
  const r = cli('run', 'tutor/socratic', '--route', join(routes, 'fake-leaky.json'), '--split', 'all', '--out', join(out, 'leaky'), '--baseline', join(out, 'good', 'report.json'))
  assert.equal(r.code, 1, r.stdout + r.stderr)
  const rep = report(join(out, 'leaky'))
  assert.equal(rep.passed, false)
  assert.ok(rep.metrics.graded_mode_leaks.value > 0)
  assert.ok(rep.metrics.no_premature_answer.value < 0.9)
  assert.ok(rep.gates.results.find((g: { metric: string }) => g.metric === 'graded_mode_leaks').passed === false)
  assert.ok(rep.gates.reasons.some((x: string) => /^regression: no_premature_answer/.test(x)))
  assert.equal(rep.baseline.sameDataset, true)
})

test('smoke selection runs a deterministic ~10% of the test split', () => {
  const r = cli('run', 'tutor/socratic', '--route', join(routes, 'fake.json'), '--smoke', '--out', join(out, 'smoke'))
  assert.equal(r.code, 0, r.stdout + r.stderr)
  const rep = report(join(out, 'smoke'))
  assert.equal(rep.summary.selected, 2)
  assert.ok(rep.cases.every((c: { split: string }) => c.split === 'test'))
})

test('usage errors exit 2 (unknown suite, production environment refused)', () => {
  assert.equal(cli('run', 'nope/suite', '--route', join(routes, 'fake.json')).code, 2)
  assert.equal(cli('run', 'tutor/socratic').code, 2)
  const prod = join(out, 'prod.json')
  writeFileSync(prod, JSON.stringify({ ...JSON.parse(readFileSync(join(routes, 'fake.json'), 'utf8')), environment: 'production' }))
  const r = cli('run', 'tutor/socratic', '--route', prod)
  assert.equal(r.code, 2)
  assert.match(r.stderr, /never writes production routes/)
})
