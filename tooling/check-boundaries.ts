/**
 * Enforces platform-planning/DEPENDENCY_MAP.md (rules M1–M10 + package layers). Fails CI on any violation.
 *   node tooling/check-boundaries.ts
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const violations: string[] = []

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
const imports = (src: string) => [...src.matchAll(IMPORT)].map((m) => m[1] ?? m[2]!).filter(Boolean)

/** Allowed @platform imports per platform package (layers from DEPENDENCY_MAP § 1). */
const LAYERS: Record<string, string[]> = {
  core: [],
  observability: ['core'],
  'tenancy-db': ['core', 'observability'],
  audit: ['core', 'observability', 'tenancy-db'],
  identity: ['core', 'observability', 'tenancy-db', 'audit'],
  jobs: ['core', 'observability', 'tenancy-db'],
  events: ['core', 'jobs', 'tenancy-db'],
  'ai-adapter-kit': ['core', 'observability'],
  'ai-gateway': ['core', 'observability', 'tenancy-db', 'audit', 'ai-adapter-kit', 'ai-adapter-*'],
  contracts: ['core', 'tenancy-db', 'jobs', 'events', 'ai-gateway'],
  'module-runtime': ['core', 'observability', 'tenancy-db', 'identity', 'audit', 'jobs', 'events', 'ai-gateway', 'contracts'],
  testing: ['*'],
}
const SYSTEM_DB_ALLOWED = new Set(['identity', 'jobs', 'ai-gateway', 'module-runtime', 'testing', 'tenancy-db'])
const MODULE_ALLOWED = ['core', 'contracts', 'observability', 'tenancy-db']
const MODULE_TEST_EXTRA = ['testing', 'ai-gateway/testing', 'tenancy-db/testing', 'module-runtime', 'module-runtime/lifecycle', 'jobs', 'app-api', 'ai-gateway']
const VENDOR_PKGS = /^(openai|@anthropic-ai\/|@google\/(generative-ai|genai)|groq-sdk|ollama$|@mistralai\/|cohere-ai)/
const VENDOR_HOSTS = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com/
const MODEL_IDS = /['"`](gpt-[0-9][\w.-]*|o[0-9]-[\w.-]+|claude-[0-9a-z][\w.-]*|gemini-[0-9][\w.-]*|llama-?[0-9][\w.-]*)['"`]/i

const platformName = (spec: string) => spec.startsWith('@platform/') ? spec.slice('@platform/'.length) : null

for (const file of walk(root)) {
  const rel = relative(root, file).split(sep).join('/')
  if (rel.startsWith('tooling/')) continue
  const src = readFileSync(file, 'utf8')
  const specs = imports(src)
  const isTest = /\.test\.ts$|\/tests?\//.test(rel) || rel.includes('/conformance/')
  const parts = rel.split('/')

  // adapters: vendor code lives only here, and adapters never import each other (M4, M10)
  const adapterOf = rel.startsWith('packages/ai-adapters/') ? parts[2] : null

  for (const spec of specs) {
    if (VENDOR_PKGS.test(spec) && !adapterOf) violations.push(`${rel}: vendor SDK "${spec}" outside packages/ai-adapters (M4)`)
    const pn = platformName(spec)
    if (adapterOf && pn?.startsWith('ai-adapter-') && pn !== 'ai-adapter-kit' && pn !== `ai-adapter-${adapterOf}`) violations.push(`${rel}: adapters must not import other adapters (M10)`)
    if (adapterOf && pn && !['ai-adapter-kit', 'observability', 'core'].includes(pn) && !isTest) violations.push(`${rel}: adapters may only import ai-adapter-kit/core/observability, not ${spec}`)
    if (spec.startsWith('@modules/') && (rel.startsWith('packages/'))) violations.push(`${rel}: packages must not import modules (M3)`)
    if (pn === 'tenancy-db/system' && rel.startsWith('modules/')) violations.push(`${rel}: modules must not use the privileged system database`)
  }

  // package layering
  if (rel.startsWith('packages/') && !adapterOf && !isTest) {
    const pkg = parts[1]!
    const allowed = LAYERS[pkg]
    for (const spec of specs) {
      const pn = platformName(spec)
      if (!pn) continue
      const base = pn.split('/')[0]!
      if (base === pkg) continue
      if (pn === 'tenancy-db/system' && !SYSTEM_DB_ALLOWED.has(pkg) && pkg !== 'audit') violations.push(`${rel}: ${pkg} may not use the privileged system database`)
      if (!allowed) {
        violations.push(`${rel}: package ${pkg} has no layer entry in check-boundaries.ts`)
        break
      }
      const ok = allowed.includes('*') || allowed.includes(base) || (base.startsWith('ai-adapter-') && allowed.includes('ai-adapter-*'))
      if (!ok) violations.push(`${rel}: ${pkg} may not import ${spec} (layer rule)`)
    }
  }

  // modules (M1, M2): only allowed platform packages and own vertical's shared folder
  if (rel.startsWith('modules/')) {
    const [, vertical, agent] = parts
    for (const spec of specs) {
      const pn = platformName(spec)
      if (pn) {
        const ok = MODULE_ALLOWED.includes(pn) || (isTest && MODULE_TEST_EXTRA.includes(pn))
        if (!ok) violations.push(`${rel}: modules may not import ${spec} (M1)`)
        if (isTest && pn.startsWith('ai-adapter-')) violations.push(`${rel}: module tests must use the fake adapter, not ${spec}`)
      }
      if (spec.startsWith('@modules/') && spec !== `@modules/${vertical}-shared`) violations.push(`${rel}: modules must not import other modules (${spec}) (M2)`)
      if (spec.startsWith('.')) {
        const target = relative(root, resolve(join(root, rel, '..'), spec)).split(sep).join('/')
        if (!target.startsWith(`modules/${vertical}/${agent}/`) && !target.startsWith(`modules/${vertical}/shared/`)) violations.push(`${rel}: relative import escapes the module (${spec}) (M2)`)
      }
    }
  }

  // apps import modules only via the generated registry (M8)
  if (rel.startsWith('apps/') && !rel.endsWith('modules.generated.ts')) {
    for (const spec of specs) if (spec.startsWith('@modules/')) violations.push(`${rel}: apps must load modules via modules.generated.ts (M8)`)
  }

  // vendor hostnames and hard-coded model ids outside adapters / registry / tests (M4, G3)
  if (!adapterOf && !isTest && VENDOR_HOSTS.test(src)) violations.push(`${rel}: vendor hostname outside adapters (M4)`)
  if (!adapterOf && !isTest && !rel.includes('/registry/') && MODEL_IDS.test(src)) violations.push(`${rel}: hard-coded provider model id ${MODEL_IDS.exec(src)![1]} (G3)`)
}

if (violations.length) {
  console.error(`Boundary violations (${violations.length}):\n- ` + violations.join('\n- '))
  process.exit(1)
}
console.log('boundaries ok')
