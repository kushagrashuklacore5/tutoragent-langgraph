/**
 * AI evaluation CLI (packages/ai-evals; AI_EVALUATION_FRAMEWORK.md).
 *
 *   node tooling/evals.ts list
 *   node tooling/evals.ts run <suite> --route <routing-config.json> [options]
 *   node tooling/evals.ts validate-judge <rubric|entailment> --labels <labels.jsonl> --route <routing-config.json> [--out validation.json]
 *
 * run options:
 *   --baseline <report.json>     apply the "> 2 points regression fails" rule against a previous report
 *   --split test|dev|all         default test (dev is for tuning; test is never used for tuning)
 *   --smoke                      PR smoke suite: deterministic ~10% sample of the test split
 *   --sample <0..1>  --tags a,b  further selection
 *   --concurrency <n>            default 4
 *   --spend-cap-micros <n>       stop starting cases once metered spend reaches this (currency micro-units)
 *   --case-timeout-ms <n>        per-case limit
 *   --tenant <uuid>              tenant to meter eval traffic to (default: the `platform-evals` tenant, created if missing)
 *   --out <dir>                  default .data/evals/<suite>/<runId>
 *   --record-standing            write passing ai_eval_standings (only when every gate passes)
 *
 * Environment: SYSTEM_DATABASE_URL (or DATABASE_URL) of a migrated platform database, and
 * PLATFORM_MASTER_KEY (base64, 32 bytes) to store connection keys. Provider keys come from the
 * environment variables named in the routing config (`apiKeyEnv`), never from the file.
 *
 * Routing config (JSON):
 *   {
 *     "environment": "eval",                         // routes are written for this environment only; "production" is refused
 *     "deployments": [
 *       { "name": "primary", "deploymentId": "<existing ai_deployments id>" },
 *       { "name": "candidate", "adapter": "<adapter type>", "model": "<provider model id>", "baseUrl": "https://…",
 *         "apiKeyEnv": "PROVIDER_API_KEY", "dataPolicy": { … }, "capabilities": { … }, "pricing": { "currency": "INR", "inputPerMTok": …, "outputPerMTok": … },
 *         "params": { "temperature": 0.3 } },
 *       { "name": "fake", "adapter": "fake", "model": "scripted-tutor", "fakeResponder": "../socratic/fake-tutor.ts" }
 *     ],
 *     "tasks": { "education.tutor.socratic_turn": ["primary"] },   // optional; default every suite task -> every deployment, in order
 *     "judges": [{ "name": "rubric", "deployment": "judge", "validation": "rubric.validation.json" }]   // optional
 *   }
 * Exit code: 0 = all gates pass, 1 = gates failed, 2 = usage / setup error.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { configureLogging } from '@platform/observability'
import { createSystemDatabase, type SystemDatabase } from '@platform/tenancy-db/system'
import { ADAPTERS, TaskRegistry, createGateway, localKeyManager, type Actor, type Capabilities, type DataPolicy, type Gateway, type Pricing } from '@platform/ai-gateway'
import { createFakeAdapter } from '@platform/ai-gateway/testing'
import {
  JUDGE_TASKS, buildReport, entailmentJudge, gitCommit, loadDatasets, recordStandings, renderMarkdown, rubricJudge, runSuite, selectCases, trustJudge, validateJudge,
  type EvalSuite, type JudgeDefinition, type JudgeLabel, type JudgeValidation, type Report, type TrustedJudge,
} from '@platform/ai-evals'

const root = resolve(import.meta.dirname, '..')
const ADMIN: Actor = { userId: null, tenantId: null, isPlatformAdmin: true, roles: [] }

class UsageError extends Error {}

interface DeploymentSpec {
  name: string
  deploymentId?: string
  adapter?: string
  model?: string
  baseUrl?: string
  apiKeyEnv?: string
  allowPrivateNetwork?: boolean
  dataPolicy?: DataPolicy
  capabilities?: Partial<Capabilities>
  pricing?: Pricing
  params?: { temperature?: number; maxOutputTokens?: number; reasoning?: 'off' | 'low' | 'medium' | 'high' }
  fakeResponder?: string
}
interface RouteConfig {
  environment?: string
  deployments: DeploymentSpec[]
  tasks?: Record<string, string[]>
  judges?: { name: string; deployment: string; validation?: string }[]
}

type SuiteModule = EvalSuite & { regressionPoints?: number; smokeSample?: number }

/** Suites live in modules/<vertical>/<agent>/evals/<suite>/suite.ts and export `suite`. */
async function discoverSuites(): Promise<{ file: string; suite: SuiteModule }[]> {
  const out: { file: string; suite: SuiteModule }[] = []
  const mods = join(root, 'modules')
  for (const v of existsSync(mods) ? readdirSync(mods) : []) {
    for (const a of safeDir(join(mods, v))) {
      for (const s of safeDir(join(mods, v, a, 'evals'))) {
        const file = join(mods, v, a, 'evals', s, 'suite.ts')
        if (!existsSync(file)) continue
        const m = (await import(pathToFileURL(file).href)) as { suite?: SuiteModule }
        if (m.suite) out.push({ file, suite: m.suite })
      }
    }
  }
  return out
}
function safeDir(p: string): string[] {
  try {
    return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return []
  }
}

const SYNTHETIC_POLICY: DataPolicy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true, sourceOfTerms: 'fake adapter (no data leaves the process)' }

function loadRouteConfig(path: string): { cfg: RouteConfig; dir: string } {
  const full = resolve(path)
  const cfg = JSON.parse(readFileSync(full, 'utf8')) as RouteConfig
  if (!Array.isArray(cfg.deployments) || !cfg.deployments.length) throw new UsageError('routing config needs a non-empty "deployments" array')
  if ((cfg.environment ?? 'eval') === 'production') throw new UsageError('the eval CLI never writes production routes; use an eval environment (standings still apply to production deployments)')
  const names = new Set<string>()
  for (const d of cfg.deployments) {
    if (!d.name || names.has(d.name)) throw new UsageError(`deployment names must be unique and non-empty (${d.name})`)
    names.add(d.name)
    if (!d.deploymentId && (!d.adapter || !d.model)) throw new UsageError(`deployment ${d.name}: give deploymentId, or adapter + model`)
    if (d.deploymentId === undefined && d.adapter !== 'fake' && !d.dataPolicy) throw new UsageError(`deployment ${d.name}: dataPolicy is required (verified provider terms)`)
  }
  return { cfg, dir: dirname(full) }
}

/** What is safe to store in the report: no keys, only env var names. */
const redactConfig = (cfg: RouteConfig) => ({ ...cfg, deployments: cfg.deployments.map(({ apiKeyEnv, ...d }) => ({ ...d, apiKeyEnv: apiKeyEnv ? `$${apiKeyEnv}` : undefined })) })

async function setup(cfg: RouteConfig, dir: string, tasks: TaskRegistry, tenantArg?: string) {
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new UsageError('set SYSTEM_DATABASE_URL (or DATABASE_URL) to a migrated platform database')
  const keyB64 = process.env.PLATFORM_MASTER_KEY
  if (!keyB64) throw new UsageError('set PLATFORM_MASTER_KEY (base64, 32 bytes)')
  const system = createSystemDatabase(url, { max: 10 })
  const adapters = { ...ADAPTERS } as Record<string, (typeof ADAPTERS)[string]>
  for (const d of cfg.deployments) {
    if (d.adapter !== 'fake') continue
    if (!d.fakeResponder) throw new UsageError(`deployment ${d.name}: the fake adapter needs "fakeResponder" (a module exporting respond(req, model))`)
    const mod = (await import(pathToFileURL(resolve(dir, d.fakeResponder)).href)) as { respond: NonNullable<Parameters<typeof createFakeAdapter>[1]>['respond'] }
    adapters.fake = createFakeAdapter('fake', { respond: mod.respond })
  }
  const environment = cfg.environment ?? 'eval'
  const gateway = createGateway({ system, keyManager: localKeyManager(Buffer.from(keyB64, 'base64')), environment, adapters, tasks, retryDelayMs: 200 })
  const tenantId = tenantArg ?? (await ensureEvalTenant(system))
  const deployments = new Map<string, string>()
  for (const d of cfg.deployments) deployments.set(d.name, d.deploymentId ?? (await ensureDeployment(system, gateway, d)))
  return { system, gateway, tenantId, deployments, environment }
}

async function ensureEvalTenant(system: SystemDatabase): Promise<string> {
  const found = await system.query<{ id: string }>(`select id from platform.tenants where slug = 'platform-evals'`)
  if (found.rows[0]) return found.rows[0].id
  const id = randomUUID()
  await system.query(`insert into platform.tenants (id, slug, name, type, policy) values ($1, 'platform-evals', 'Platform evaluations (no student data)', 'institution', '{}') on conflict (slug) do nothing`, [id])
  return (await system.query<{ id: string }>(`select id from platform.tenants where slug = 'platform-evals'`)).rows[0]!.id
}

/** Reuse (or create) the eval connection `eval:<name>` and its deployment of the model. Never overwrites an approved registry entry. */
async function ensureDeployment(system: SystemDatabase, gateway: Gateway, d: DeploymentSpec): Promise<string> {
  const adapter = d.adapter!
  const apiKey = d.apiKeyEnv ? process.env[d.apiKeyEnv] : undefined
  if (d.apiKeyEnv && !apiKey) throw new UsageError(`deployment ${d.name}: environment variable ${d.apiKeyEnv} is not set`)
  const name = `eval:${d.name}`
  let conn = (await system.query<{ id: string }>(`select id from platform.ai_connections where tenant_id is null and name = $1 and adapter = $2`, [name, adapter])).rows[0]
  const isFake = adapter === 'fake'
  if (!conn) {
    conn = await gateway.admin.createConnection(ADMIN, {
      adapter, name, baseUrl: d.baseUrl ?? (isFake ? 'http://127.0.0.1:9' : undefined), apiKey, allowPrivateNetwork: d.allowPrivateNetwork ?? isFake,
      dataPolicy: d.dataPolicy ?? SYNTHETIC_POLICY, enabledCapabilities: d.capabilities,
    })
  } else if (apiKey) {
    await gateway.admin.rotateKey(ADMIN, conn.id, apiKey)
  }
  const approved = (await system.query(`select 1 from platform.ai_models where adapter = $1 and model_id = $2 and approved`, [adapter, d.model])).rows.length > 0
  if (!approved) {
    if (!d.capabilities && !isFake) throw new UsageError(`deployment ${d.name}: model ${adapter}/${d.model} is not approved in the registry; approve it first or give "capabilities"`)
    await gateway.admin.approveModel(ADMIN, { adapter, modelId: d.model!, declared: d.capabilities ?? { operations: ['generate', 'stream'], structuredOutput: 'json_mode', tools: 'single', contextWindow: 128000 }, sourceUrl: isFake ? 'fake://eval' : undefined })
  }
  const existing = (await system.query<{ id: string }>(`select id from platform.ai_deployments where connection_id = $1 and model_id = $2 order by created_at limit 1`, [conn.id, d.model])).rows[0]
  if (existing) {
    if (d.pricing) await system.query('update platform.ai_deployments set pricing = $2 where id = $1', [existing.id, JSON.stringify(d.pricing)])
    return existing.id
  }
  return (await gateway.admin.createDeployment(ADMIN, { connectionId: conn.id, modelId: d.model!, pricing: d.pricing })).id
}

async function setRoutes(gateway: Gateway, cfg: RouteConfig, deployments: Map<string, string>, taskIds: string[], environment: string) {
  for (const taskId of taskIds) {
    const names = cfg.tasks?.[taskId] ?? cfg.tasks?.['*'] ?? cfg.deployments.filter((d) => !cfg.judges?.some((j) => j.deployment === d.name)).map((d) => d.name)
    const candidates = names.map((n) => {
      const id = deployments.get(n)
      if (!id) throw new UsageError(`task ${taskId}: unknown deployment "${n}"`)
      return { deploymentId: id, params: cfg.deployments.find((d) => d.name === n)?.params }
    })
    await gateway.admin.setRoute(ADMIN, { target: `task:${taskId}`, environment, candidates })
  }
}

function judgeDefinition(name: string): JudgeDefinition {
  if (name === 'rubric') return rubricJudge()
  if (name === 'entailment') return entailmentJudge()
  throw new UsageError(`unknown judge ${name} (rubric | entailment)`)
}

const slug = (s: string) => s.replace(/[^a-z0-9_-]+/gi, '__')

async function cmdRun(suiteName: string, a: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof a.route !== 'string') throw new UsageError('--route <routing-config.json> is required')
  const found = (await discoverSuites()).find((s) => s.suite.name === suiteName)
  if (!found) throw new UsageError(`unknown suite ${suiteName}; see "node tooling/evals.ts list"`)
  const suite = found.suite
  const { cfg, dir } = loadRouteConfig(a.route)
  const all = await loadDatasets(suite.datasets)
  const split = a.smoke ? 'test' : a.split === 'all' ? undefined : ((a.split as 'dev' | 'test' | undefined) ?? 'test')
  const sample = a.smoke ? (suite.smokeSample ?? 0.1) : a.sample !== undefined ? Number(a.sample) : undefined
  const selection = { split: split ?? 'all', sample: sample ?? 1, tags: typeof a.tags === 'string' ? a.tags.split(',') : [], seed: a.smoke ? 'smoke' : 'sample' }
  const cases = selectCases(all.cases, { split, sample, tags: selection.tags, seed: selection.seed })
  if (!cases.length) throw new UsageError('selection matched no cases')

  const tasks = new TaskRegistry()
  for (const t of suite.tasks) tasks.register(t)
  if (cfg.judges?.length) for (const t of JUDGE_TASKS) tasks.register(t)
  const env = await setup(cfg, dir, tasks, typeof a.tenant === 'string' ? a.tenant : undefined)
  try {
    const taskIds = [...new Set(cases.map((c) => c.task))]
    await setRoutes(env.gateway, cfg, env.deployments, taskIds, env.environment)
    const judges: TrustedJudge[] = []
    for (const j of cfg.judges ?? []) {
      const def = judgeDefinition(j.name)
      await env.gateway.admin.setRoute(ADMIN, { target: `task:${def.taskId}`, environment: env.environment, candidates: [{ deploymentId: env.deployments.get(j.deployment)! }] })
      const validation = j.validation ? (JSON.parse(readFileSync(resolve(dir, j.validation), 'utf8')) as JudgeValidation) : undefined
      judges.push(trustJudge(def, validation))
    }
    const usesFake = cfg.deployments.some((d) => d.adapter === 'fake')
    let done = 0
    const run = await runSuite({
      gateway: env.gateway, suite, cases, tenantId: env.tenantId, metering: env.system, judges,
      concurrency: a.concurrency ? Number(a.concurrency) : 4,
      spendCapMicros: a['spend-cap-micros'] ? Number(a['spend-cap-micros']) : undefined,
      caseTimeoutMs: a['case-timeout-ms'] ? Number(a['case-timeout-ms']) : undefined,
      dataset: { version: all.version, files: all.datasets.map((d) => ({ file: relative(root, d.file).split('\\').join('/'), version: d.version, cases: d.cases.length })) },
      selection, routeConfig: redactConfig(cfg), commit: gitCommit(root),
      onCase: (r) => process.stderr.write(`\r${++done}/${cases.length} ${r.passed ? 'pass' : r.status === 'skipped' ? 'skip' : 'FAIL'} ${r.id}`.padEnd(80)),
    })
    process.stderr.write('\n')
    const baseline = typeof a.baseline === 'string' ? (JSON.parse(readFileSync(resolve(a.baseline), 'utf8')) as Report) : null
    const notes = usesFake ? ['Fake adapter run: this proves the evaluation pipeline works; it is NOT evidence of model quality.'] : []
    const report = buildReport(run, { gates: suite.gates, baseline, regressionPoints: suite.regressionPoints, notes })
    const out = resolve(typeof a.out === 'string' ? a.out : join(root, '.data', 'evals', slug(suite.name), run.runId))
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    writeFileSync(join(out, 'report.md'), renderMarkdown(report))
    console.log(`${report.passed ? 'PASS' : 'FAIL'} ${suite.name} run ${run.runId}: ${report.summary.passedCases}/${report.summary.attempted} cases passed`)
    for (const g of report.gates.results) console.log(`  ${g.passed ? 'ok  ' : 'FAIL'} ${g.expr}  (value ${g.value ?? 'n/a'})`)
    for (const r of report.gates.reasons.filter((x) => !x.startsWith('gate failed'))) console.log(`  FAIL ${r}`)
    console.log(`report: ${join(out, 'report.md')}`)
    if (a['record-standing']) {
      for (const d of await recordStandings(env.gateway.admin, ADMIN, report)) console.log(`standing ${d.taskId} @ ${d.deploymentId}: ${d.recorded ? 'recorded' : `not recorded (${d.reason})`}`)
    }
    return report.passed ? 0 : 1
  } finally {
    await env.system.close()
  }
}


/**
 * Marking evaluation: run the production marking pipeline (`markWritten`) over educator-marked answers and
 * report agreement (overall / by type / by difficulty / by data source). See modules/.../evals/marking/.
 */
async function cmdRunMarking(a: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof a.route !== 'string') throw new UsageError('--route <routing-config.json> is required')
  if (typeof a.dataset !== 'string') throw new UsageError('--dataset <file.jsonl[,file2.jsonl]> is required')
  const { runMarkingEval } = await import('../modules/education-agents/tutor-agent/evals/marking/run.ts')
  const { ASSESSMENT_TASKS, MARK_PROMPT_VERSION } = await import('../modules/education-agents/tutor-agent/src/assessments.ts')
  const { cfg, dir } = loadRouteConfig(a.route)
  const all = await loadDatasets(a.dataset.split(',').map((f) => resolve(f)))
  const tasks = new TaskRegistry()
  for (const t of ASSESSMENT_TASKS) tasks.register(t)
  const env = await setup(cfg, dir, tasks, typeof a.tenant === 'string' ? a.tenant : undefined)
  try {
    await setRoutes(env.gateway, cfg, env.deployments, ['education.tutor.mark_answer'], env.environment)
    const started = new Date().toISOString()
    let done = 0
    const res = await runMarkingEval((taskId, input, ctx) => env.gateway.run(taskId, input, { tenantId: env.tenantId, ...ctx }).then((r) => {
      process.stderr.write(`\r${++done} marking calls`.padEnd(40))
      return r
    }), all.cases as never, { concurrency: a.concurrency ? Number(a.concurrency) : 1 })
    process.stderr.write('\n')
    const sources = [...new Set(all.cases.map((c) => c.source))]
    const usesFake = cfg.deployments.some((d) => d.adapter === 'fake')
    const notes = [
      ...(sources.includes('synthetic') ? ['Contains SYNTHETIC fixture answers: their figures check the pipeline only and are NOT evidence of marking quality. Read bySource.educator for real data.'] : []),
      ...(usesFake ? ['Fake adapter run: pipeline check only.'] : []),
      'Benchmarks for automated constructed-response scoring (Williamson, Xi & Breyer 2012): QWK >= 0.70, |SMD| <= 0.15. Small n => wide intervals.',
    ]
    const report = {
      kind: 'marking-eval', startedAt: started, finishedAt: new Date().toISOString(), notes,
      reproducibility: { datasetVersion: all.version, files: all.datasets.map((d) => ({ file: relative(root, d.file).split('\\').join('/'), version: d.version, cases: d.cases.length })), promptVersion: MARK_PROMPT_VERSION, models: res.models, routeConfig: redactConfig(cfg), commit: gitCommit(root), node: process.version },
      failures: res.failures, ...res.report, outcomes: res.outcomes,
    }
    const out = resolve(typeof a.out === 'string' ? a.out : join(root, '.data', 'evals', 'marking', started.replace(/[:.]/g, '-')))
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2))
    const fmt = (b: { n: number; exact: { value: number | null }; adjacent: { value: number | null }; overMark: { value: number | null }; underMark: { value: number | null }; partialAccuracy: { value: number | null; n: number }; criterionExact: { value: number | null }; mae: number | null; qwk: number | null; smd: number | null }) =>
      `n=${b.n} exact=${b.exact.value} adjacent=${b.adjacent.value} over=${b.overMark.value} under=${b.underMark.value} partial=${b.partialAccuracy.value}(n=${b.partialAccuracy.n}) criterion=${b.criterionExact.value} MAE=${b.mae} QWK=${b.qwk} SMD=${b.smd}`
    const lines = [`# Marking evaluation ${started}`, '', ...notes.map((n) => `> ${n}`), '', `dataset ${all.version.slice(0, 12)} · prompt ${MARK_PROMPT_VERSION} · models ${res.models.join(', ') || 'n/a'} · failures ${res.failures.length} · transient retries ${res.transientRetries}`, '',
      `## Overall (review rate ${res.report.overall.reviewRate.value})`, `- settled: ${fmt(res.report.overall.settled)}`, `- provisional: ${fmt(res.report.overall.provisional)}`, '']
    for (const [title, group] of [['By source', res.report.bySource], ['By type', res.report.byType], ['By difficulty', res.report.byDifficulty]] as const) {
      lines.push(`## ${title}`)
      for (const [k, m] of Object.entries(group)) lines.push(`- **${k}** (review ${m.reviewRate.value}) settled: ${fmt(m.settled)}`)
      lines.push('')
    }
    writeFileSync(join(out, 'report.md'), lines.join('\n'))
    console.log(lines.slice(4, 8).join('\n'))
    console.log(`report: ${join(out, 'report.md')}`)
    return res.failures.length ? 1 : 0
  } finally {
    await env.system.close()
  }
}

/**
 * Build a REAL marking dataset from educator-marked written answers of one institution (responses an educator
 * marked or confirmed per criterion). Anonymised: no names, emails or user ids; ids are one-way hashes.
 * Student answers are personal data: run only with consent for this use (--confirm-consent).
 */
async function cmdExportMarking(a: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof a.tenant !== 'string' || typeof a.out !== 'string') throw new UsageError('--tenant <uuid> --out <file.jsonl> are required')
  if (a['confirm-consent'] !== true) throw new UsageError('student answers are personal data: pass --confirm-consent to confirm consent covers marking evaluation')
  const url = process.env.SYSTEM_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new UsageError('set SYSTEM_DATABASE_URL (or DATABASE_URL)')
  const system = createSystemDatabase(url, { max: 2 })
  try {
    const rows = (await system.query<{ id: string; stem: string; answer_spec: { type: string; modelAnswer: string; rubric: { id: string; criterion: string; points: number; keyPoints: string[] }[]; acceptable?: string[] }; difficulty: string; item_id: string; response: unknown; grading: { criteria?: { id: string; awarded: number }[]; history?: { reason: string }[] } }>(
      `select r.id, i.stem, i.answer_spec, i.difficulty, i.id as item_id, r.response, r.grading
         from education_tutor.assessment_responses r join education_tutor.items i on i.id = r.item_id
        where r.tenant_id = $1 and r.graded_by = 'educator' and i.type in ('short', 'descriptive') and jsonb_array_length(coalesce(r.grading->'history', '[]'::jsonb)) > 0`, [a.tenant])).rows
    const hash = (x: string) => createHash('sha256').update(x).digest('hex').slice(0, 16)
    const lines = rows.filter((r) => typeof r.response === 'string' && r.grading.criteria?.length).map((r) => JSON.stringify({
      id: `edu-${hash(r.id)}`, task: 'education.tutor.mark_answer', source: 'educator', split: 'test', tags: [r.answer_spec.type, `item-${hash(r.item_id).slice(0, 8)}`],
      input: { stem: r.stem, type: r.answer_spec.type, modelAnswer: r.answer_spec.modelAnswer, rubric: r.answer_spec.rubric, acceptable: r.answer_spec.acceptable ?? [], answer: r.response },
      context: { difficulty: Number(r.difficulty), itemRef: hash(r.item_id) },
      expect: [{ grader: 'reference_marks', total: r.grading.criteria!.reduce((s, c) => s + c.awarded, 0), criteria: Object.fromEntries(r.grading.criteria!.map((c) => [c.id, c.awarded])), educatorFeedback: r.grading.history!.at(-1)!.reason }],
    }))
    writeFileSync(resolve(a.out), lines.join('\n') + (lines.length ? '\n' : ''))
    console.log(`exported ${lines.length} educator-marked answers to ${resolve(a.out)}`)
    return 0
  } finally {
    await system.close()
  }
}

async function cmdValidateJudge(name: string, a: Record<string, string | boolean | undefined>): Promise<number> {
  if (typeof a.route !== 'string' || typeof a.labels !== 'string') throw new UsageError('--route and --labels are required')
  const def = judgeDefinition(name)
  const { cfg, dir } = loadRouteConfig(a.route)
  const labelled = readFileSync(resolve(a.labels), 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l) as JudgeLabel)
  const tasks = new TaskRegistry()
  for (const t of JUDGE_TASKS) tasks.register(t)
  const env = await setup(cfg, dir, tasks, typeof a.tenant === 'string' ? a.tenant : undefined)
  try {
    const dep = cfg.judges?.find((j) => j.name === name)?.deployment ?? cfg.deployments[0]!.name
    await env.gateway.admin.setRoute(ADMIN, { target: `task:${def.taskId}`, environment: env.environment, candidates: [{ deploymentId: env.deployments.get(dep)! }] })
    const v = await validateJudge({ gateway: env.gateway, judge: def, labelled, tenantId: env.tenantId, threshold: a.threshold ? Number(a.threshold) : undefined })
    const out = typeof a.out === 'string' ? resolve(a.out) : resolve(`${name}.validation.json`)
    writeFileSync(out, JSON.stringify(v, null, 2))
    console.log(`${v.trusted ? 'TRUSTED' : 'NOT TRUSTED'} ${v.judge}@${v.version}: agreement ${v.agreement.toFixed(3)} (n=${v.n}, κ=${v.kappa.toFixed(3)}) -> ${out}`)
    return v.trusted ? 0 : 1
  } finally {
    await env.system.close()
  }
}

async function main(): Promise<number> {
  configureLogging({ level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error' | undefined) ?? 'error', sink: (l) => process.stderr.write(l + '\n') })
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      route: { type: 'string' }, baseline: { type: 'string' }, split: { type: 'string' }, smoke: { type: 'boolean' }, sample: { type: 'string' }, tags: { type: 'string' },
      concurrency: { type: 'string' }, 'spend-cap-micros': { type: 'string' }, 'case-timeout-ms': { type: 'string' }, tenant: { type: 'string' }, out: { type: 'string' },
      'record-standing': { type: 'boolean' }, labels: { type: 'string' }, threshold: { type: 'string' },
      dataset: { type: 'string' }, 'confirm-consent': { type: 'boolean' },
    },
  })
  const [cmd, arg] = positionals
  if (cmd === 'list') {
    for (const s of await discoverSuites()) console.log(`${s.suite.name}  (${relative(root, s.file)})  gates: ${s.suite.gates.join('; ')}`)
    return 0
  }
  if (cmd === 'run' && arg) return cmdRun(arg, values)
  if (cmd === 'validate-judge' && arg) return cmdValidateJudge(arg, values)
  if (cmd === 'run-marking') return cmdRunMarking(values)
  if (cmd === 'export-marking') return cmdExportMarking(values)
  throw new UsageError('usage: node tooling/evals.ts list | run <suite> --route <config.json> [--baseline report.json] | validate-judge <rubric|entailment> --labels <file> --route <config.json>')
}

main().then((code) => process.exit(code), (e: Error) => {
  console.error(e instanceof UsageError ? e.message : `${e.name}: ${e.message}`)
  process.exit(2)
})
