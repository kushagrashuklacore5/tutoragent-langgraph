import { Ajv2020 } from 'ajv/dist/2020.js'
import { AppError, forbidden, newId, notFound, badRequest } from '@platform/core'
import { currentTrace, logger, withSpan } from '@platform/observability'
import {
  GatewayError, checkBaseUrl, createHttpClient,
  type Capabilities, type DiscoveredModel, type EmbedResult, type GenerateRequest, type GenerateResult, type Message,
  type ProviderAdapter, type ResolvedConnection, type StreamEvent, type ToolCall, type ToolChoice, type ToolDefinition, type TranscribeRequest, type TranscribeResult, type Usage,
} from '@platform/ai-adapter-kit'
import type { SystemDatabase } from '@platform/tenancy-db/system'
import { recordSystemAudit } from '@platform/audit'
import { normalizeCapabilities, narrow, structuredMode } from './capabilities.ts'
import { isDataPolicy, type DataPolicy } from './policy.ts'
import { createSecretBroker, type KeyManager } from './secrets.ts'
import { createStore, type ConnectionRow, type DeploymentRow, type Pricing, type RouteCandidate } from './store.ts'
import { candidateIssues, resolveCandidates, type EligibleCandidate, type RoutingContext } from './routing.ts'
import { budgetExceeded, recordOperation, usageSummary } from './metering.ts'
import { probeDeployment } from './probes.ts'
import { TaskRegistry, type TaskDefinition } from './tasks.ts'

// ── public types ──────────────────────────────────────────────────

export interface CallContext {
  tenantId: string
  userId?: string
  promptVersion?: string
  signal?: AbortSignal
}
export interface RunInput {
  messages: Message[]
  tools?: ToolDefinition[]
  toolChoice?: ToolChoice
  maxOutputTokens?: number
  temperature?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'
  stop?: string[]
  seed?: number
}
export interface RouteInfo {
  deploymentId: string
  connectionId: string
  adapter: string
  modelId: string
  attempt: number
  fallback: boolean
}
export interface RunResult {
  text: string
  /** parsed and schema-validated output when the task declares an outputSchema */
  json?: unknown
  toolCalls: ToolCall[]
  finish: GenerateResult['finish']
  usage: Usage
  route: RouteInfo
  operationId: string
}
export type GatewayStreamEvent = StreamEvent | { t: 'route'; route: RouteInfo } | { t: 'output'; json: unknown }

export interface Actor {
  userId: string | null
  tenantId: string | null
  isPlatformAdmin: boolean
  roles: string[]
}

export interface GatewayOptions {
  system: SystemDatabase
  keyManager: KeyManager
  environment: string
  adapters: Record<string, ProviderAdapter>
  tasks?: TaskRegistry
  /** retries on the same deployment for retryable errors before falling back */
  sameDeploymentRetries?: number
  retryDelayMs?: number
  /** longest provider-advised wait (Retry-After) honoured before falling back instead (default 20 s) */
  maxRetryWaitMs?: number
  /** circuit breaker: consecutive failures before a deployment is skipped, and for how long */
  breakerThreshold?: number
  breakerOpenMs?: number
  /** test hook: DNS resolver for the outbound HTTP client */
  resolver?: (host: string) => Promise<{ address: string; family: number }[]>
}

const ajv = new Ajv2020({ allErrors: true, strict: false })

function parseJsonOutput(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  return JSON.parse(t)
}

export function createGateway(o: GatewayOptions) {
  const tasks = o.tasks ?? new TaskRegistry()
  const store = createStore(o.system)
  const secrets = createSecretBroker(o.system, o.keyManager)
  const routingCtx: RoutingContext = { store, environment: o.environment, adapterTypes: new Set(Object.keys(o.adapters)) }
  const retries = o.sameDeploymentRetries ?? 1
  const breaker = new Map<string, { fails: number; openUntil: number }>()

  const adapterFor = (type: string): ProviderAdapter => {
    const a = o.adapters[type]
    if (!a) throw new GatewayError('invalid_request', `adapter ${type} is not available in this build`)
    return a
  }

  async function resolveConnection(conn: ConnectionRow): Promise<ResolvedConnection> {
    const adapter = adapterFor(conn.adapter)
    const allowPrivate = conn.scope === 'platform' && conn.allow_private_network && adapter.descriptor.supportsPrivateNetwork
    const baseUrl = conn.base_url ?? adapter.descriptor.defaultBaseUrl
    if (!baseUrl) throw new GatewayError('invalid_request', `connection ${conn.name} has no base URL`)
    return {
      id: conn.id,
      baseUrl,
      apiKey: conn.secret_id ? await secrets.reveal(conn.secret_id, conn.tenant_id) : undefined,
      http: createHttpClient({ requireHttps: !allowPrivate, allowPrivateNetwork: allowPrivate }, { resolver: o.resolver }),
      timeoutMs: conn.timeout_ms,
    }
  }

  function buildRequest(task: TaskDefinition, input: RunInput, cand: EligibleCandidate): GenerateRequest {
    const caps = cand.capabilities
    const messages = [...input.messages]
    let responseFormat: GenerateRequest['responseFormat']
    if (task.outputSchema) {
      const mode = structuredMode(caps)
      if (!mode) throw new GatewayError('unsupported_capability', 'deployment has no structured output')
      responseFormat = { type: 'json', mode, schema: task.outputSchema, name: task.id.split('.').pop()! }
      if (mode === 'json_mode') {
        messages.unshift({ role: 'system', content: `Respond only with a JSON object that conforms to this JSON Schema:\n${JSON.stringify(task.outputSchema)}` })
      }
    }
    const reasoning = input.reasoning ?? cand.params?.reasoning ?? task.defaults?.reasoning
    let maxOut = input.maxOutputTokens ?? cand.params?.maxOutputTokens ?? task.defaults?.maxOutputTokens ?? 1024
    if (caps.maxOutputTokens) maxOut = Math.min(maxOut, caps.maxOutputTokens)
    return {
      messages,
      tools: input.tools,
      toolChoice: input.toolChoice,
      responseFormat,
      maxOutputTokens: maxOut,
      temperature: input.temperature ?? cand.params?.temperature ?? task.defaults?.temperature,
      // only send reasoning controls to models verified to support them
      reasoning: caps.reasoningControl ? reasoning : undefined,
      stop: input.stop,
      seed: input.seed,
    }
  }

  function breakerOpen(id: string): boolean {
    const b = breaker.get(id)
    return !!b && b.openUntil > Date.now()
  }
  function breakerRecord(id: string, ok: boolean) {
    if (ok) return void breaker.delete(id)
    const b = breaker.get(id) ?? { fails: 0, openUntil: 0 }
    b.fails++
    if (b.fails >= (o.breakerThreshold ?? 5)) {
      b.openUntil = Date.now() + (o.breakerOpenMs ?? 30_000)
      b.fails = 0
    }
    breaker.set(id, b)
  }

  async function prepare(taskId: string, ctx: CallContext, op: 'generate' | 'stream' | 'embed' | 'transcribe') {
    const task = tasks.get(taskId)
    if (!task) throw new GatewayError('unknown_task', `unknown AI task ${taskId}`)
    const declaredOp = task.requires.operation
    const special = (x: string) => x === 'embed' || x === 'transcribe'
    if (special(op) || special(declaredOp) ? op !== declaredOp : false) throw new GatewayError('invalid_request', `task ${taskId} is declared for ${declaredOp}`)
    if ((await budgetExceeded(o.system, ctx.tenantId, task.owner)).exceeded) throw new GatewayError('budget_exceeded', 'AI budget for this period is exhausted')
    const policy = await store.tenantPolicy(ctx.tenantId)
    const { eligible, rejected, route } = await resolveCandidates(routingCtx, task, ctx.tenantId, policy)
    if (!eligible.length) {
      const why = route ? rejected.map((r) => `${r.deploymentId}: ${r.reasons.join('; ')}`).join(' | ') : 'no route configured'
      logger.warn('no eligible AI route', { taskId, tenantId: ctx.tenantId, why })
      throw new GatewayError('no_eligible_route', `No eligible model for ${taskId} (${why})`)
    }
    return { task, candidates: eligible }
  }

  const meter = (task: TaskDefinition, ctx: CallContext, c: EligibleCandidate, attempt: number, fallback: boolean, start: number, extra: { status: 'ok' | 'error'; errorKind?: string; usage?: Usage; ttftMs?: number | null }) =>
    recordOperation(o.system, {
      tenantId: ctx.tenantId, moduleId: task.owner, taskId: task.id, routeId: c.route.id, routeVersion: c.route.version,
      deploymentId: c.deployment.id, connectionId: c.connection.id, adapter: c.connection.adapter, modelId: c.deployment.model_id,
      attempt, fallback, byok: c.connection.tenant_id !== null, latencyMs: performance.now() - start,
      pricing: c.deployment.pricing ?? c.connection.infra_cost, promptVersion: ctx.promptVersion, traceId: currentTrace()?.traceId, ...extra,
    })

  function validateOutput(task: TaskDefinition, text: string): { ok: true; json: unknown } | { ok: false; error: string } {
    try {
      const json = parseJsonOutput(text)
      const validate = ajv.compile(task.outputSchema!)
      if (validate(json)) return { ok: true, json }
      return { ok: false, error: ajv.errorsText(validate.errors) }
    } catch (e) {
      return { ok: false, error: `not valid JSON: ${(e as Error).message}` }
    }
  }

  /**
   * How long to wait before retrying on the same deployment: the provider's advice when given (rate
   * limits), else linear backoff. null = the advised wait is too long; fall back / fail instead of stalling.
   */
  function retryWait(err: GatewayError, n: number): number | null {
    if (err.retryAfterMs !== undefined) return err.retryAfterMs <= (o.maxRetryWaitMs ?? 20_000) ? err.retryAfterMs + 50 : null
    return (o.retryDelayMs ?? 200) * n
  }

  /** Run a generate task with routing, retries, eligible-only fallback, structured-output validation and metering. */
  async function run(taskId: string, input: RunInput, ctx: CallContext): Promise<RunResult> {
    return withSpan(`ai.run ${taskId}`, async () => {
      const { task, candidates } = await prepare(taskId, ctx, 'generate')
      let attempt = 0
      let lastErr: unknown
      for (const [i, c] of candidates.entries()) {
        if (breakerOpen(c.deployment.id)) {
          lastErr = new GatewayError('overloaded', 'deployment temporarily skipped (circuit open)')
          continue
        }
        const conn = await resolveConnection(c.connection)
        const adapter = adapterFor(c.connection.adapter)
        for (let r = 0; r <= retries; r++) {
          attempt++
          const start = performance.now()
          try {
            const req = buildRequest(task, input, c)
            let result = await adapter.generate(conn, c.deployment.model_id, req, ctx.signal)
            let json: unknown
            if (task.outputSchema) {
              let v = validateOutput(task, result.text)
              if (!v.ok) {
                // one repair attempt on the same deployment
                const repair: GenerateRequest = { ...req, messages: [...req.messages, { role: 'assistant', content: result.text }, { role: 'user', content: `Your reply did not match the required JSON Schema (${v.error}). Reply again with only the corrected JSON object.` }] }
                result = await adapter.generate(conn, c.deployment.model_id, repair, ctx.signal)
                v = validateOutput(task, result.text)
                if (!v.ok) throw new GatewayError('invalid_output', `output did not match schema after repair: ${v.error}`)
              }
              json = v.json
            }
            breakerRecord(c.deployment.id, true)
            const operationId = await meter(task, ctx, c, attempt, i > 0, start, { status: 'ok', usage: result.usage })
            return {
              text: result.text, json, toolCalls: result.toolCalls, finish: result.finish, usage: result.usage, operationId,
              route: { deploymentId: c.deployment.id, connectionId: c.connection.id, adapter: c.connection.adapter, modelId: c.deployment.model_id, attempt, fallback: i > 0 },
            }
          } catch (e) {
            const err = e instanceof GatewayError ? e : new GatewayError('provider_error', (e as Error).message)
            lastErr = err
            await meter(task, ctx, c, attempt, i > 0, start, { status: 'error', errorKind: err.kind })
            // a rate limit is the provider pacing us, not a health failure: it must not trip the circuit breaker
            if ((err.retryable || err.fallbackEligible) && err.kind !== 'rate_limited') breakerRecord(c.deployment.id, false)
            const wait = retryWait(err, r + 1)
            if (err.retryable && r < retries && wait !== null) {
              await new Promise((res) => setTimeout(res, wait))
              continue
            }
            if (!err.fallbackEligible) throw err
            break // try next eligible candidate
          }
        }
      }
      throw lastErr instanceof GatewayError ? lastErr : new GatewayError('provider_error', 'all candidates failed')
    })
  }

  /** Stream a task. Fallback is only possible before any output has been sent to the caller. */
  async function* stream(taskId: string, input: RunInput, ctx: CallContext): AsyncIterable<GatewayStreamEvent> {
    const { task, candidates } = await prepare(taskId, ctx, 'stream')
    let attempt = 0
    let lastErr: unknown
    for (const [i, c] of candidates.entries()) {
      if (breakerOpen(c.deployment.id)) continue
      attempt++
      const conn = await resolveConnection(c.connection)
      const adapter = adapterFor(c.connection.adapter)
      const start = performance.now()
      let sentOutput = false
      let ttft: number | null = null
      let usage: Usage | undefined
      let text = ''
      try {
        const route: RouteInfo = { deploymentId: c.deployment.id, connectionId: c.connection.id, adapter: c.connection.adapter, modelId: c.deployment.model_id, attempt, fallback: i > 0 }
        const events: GatewayStreamEvent[] = []
        for await (const ev of adapter.stream(conn, c.deployment.model_id, buildRequest(task, input, c), ctx.signal)) {
          if (ev.t === 'usage') usage = ev.usage
          if (ev.t === 'text') {
            text += ev.delta
            if (ttft === null) ttft = Math.round(performance.now() - start)
          }
          if (!sentOutput && (ev.t === 'text' || ev.t === 'tool_call')) {
            sentOutput = true
            yield { t: 'route', route }
            for (const q of events) yield q
            events.length = 0
          }
          if (sentOutput) yield ev
          else events.push(ev)
        }
        if (!sentOutput) {
          yield { t: 'route', route }
          for (const q of events) yield q
        }
        if (task.outputSchema) {
          const v = validateOutput(task, text)
          if (!v.ok) throw new GatewayError('invalid_output', `streamed output did not match schema: ${v.error}`)
          yield { t: 'output', json: v.json }
        }
        breakerRecord(c.deployment.id, true)
        await meter(task, ctx, c, attempt, i > 0, start, { status: 'ok', usage, ttftMs: ttft })
        return
      } catch (e) {
        const err = e instanceof GatewayError ? e : new GatewayError('provider_error', (e as Error).message)
        lastErr = err
        await meter(task, ctx, c, attempt, i > 0, start, { status: 'error', errorKind: err.kind, usage, ttftMs: ttft })
        if (err.fallbackEligible && err.kind !== 'rate_limited') breakerRecord(c.deployment.id, false)
        if (sentOutput || !err.fallbackEligible) throw err
      }
    }
    throw lastErr instanceof GatewayError ? lastErr : new GatewayError('no_eligible_route', 'all candidates unavailable')
  }

  /** Embeddings: one deployment, never switched (vectors from different models are not comparable). */
  async function embed(taskId: string, inputs: string[], ctx: CallContext, purpose: 'document' | 'query' = 'document'): Promise<EmbedResult & { route: RouteInfo }> {
    const { task, candidates } = await prepare(taskId, ctx, 'embed')
    const c = candidates[0]!
    const adapter = adapterFor(c.connection.adapter)
    if (!adapter.embed) throw new GatewayError('unsupported_capability', `adapter ${c.connection.adapter} has no embeddings`)
    const conn = await resolveConnection(c.connection)
    let attempt = 0
    for (;;) {
      attempt++
      const start = performance.now()
      try {
        const r = await adapter.embed(conn, c.deployment.model_id, { inputs, purpose, dimensions: task.requires.embeddingDimensions }, ctx.signal)
        if (task.requires.embeddingDimensions && r.dimensions !== task.requires.embeddingDimensions) {
          throw new GatewayError('invalid_output', `embedding dimensions ${r.dimensions} != required ${task.requires.embeddingDimensions}`)
        }
        await meter(task, ctx, c, attempt, false, start, { status: 'ok', usage: r.usage })
        return { ...r, route: { deploymentId: c.deployment.id, connectionId: c.connection.id, adapter: c.connection.adapter, modelId: c.deployment.model_id, attempt, fallback: false } }
      } catch (e) {
        const err = e instanceof GatewayError ? e : new GatewayError('provider_error', (e as Error).message)
        await meter(task, ctx, c, attempt, false, start, { status: 'error', errorKind: err.kind })
        const wait = retryWait(err, attempt)
        if (!err.retryable || attempt > retries || wait === null) throw err
        await new Promise((res) => setTimeout(res, wait))
      }
    }
  }

  // ── administration ─────────────────────────────────────────────

  function assertScope(actor: Actor, tenantId: string | null) {
    if (tenantId === null) {
      if (!actor.isPlatformAdmin) throw forbidden('Platform AI configuration requires a platform admin')
    } else if (!actor.isPlatformAdmin && !(actor.tenantId === tenantId && actor.roles.includes('tenant_admin'))) {
      throw forbidden('Tenant AI configuration requires a tenant admin of that tenant')
    }
  }
  const audit = (actor: Actor, tenantId: string | null, action: string, targetType: string, targetId: string, metadata: Record<string, unknown> = {}) =>
    recordSystemAudit(o.system, { tenantId: tenantId ?? actor.tenantId, actorUserId: actor.userId, action, targetType, targetId, metadata })

  function publicConnection(c: ConnectionRow, secret?: { fingerprint: string; last4: string } | null) {
    return {
      id: c.id, scope: c.scope, tenantId: c.tenant_id, adapter: c.adapter, name: c.name, baseUrl: c.base_url, allowPrivateNetwork: c.allow_private_network,
      dataPolicy: c.data_policy, enabledCapabilities: c.enabled_capabilities, enabledModels: c.enabled_models, timeoutMs: c.timeout_ms, enabled: c.enabled,
      status: c.status, lastTest: c.last_test, version: c.version, key: secret ? { fingerprint: secret.fingerprint, last4: secret.last4 } : null,
    }
  }

  const admin = {
    adapters() {
      return Object.values(o.adapters).map((a) => a.descriptor)
    },

    async createConnection(actor: Actor, input: {
      tenantId?: string | null; adapter: string; name: string; baseUrl?: string; apiKey?: string; allowPrivateNetwork?: boolean
      dataPolicy: DataPolicy; enabledCapabilities?: Partial<Capabilities>; enabledModels?: string[]; timeoutMs?: number; infraCost?: Pricing
    }) {
      const tenantId = input.tenantId ?? null
      assertScope(actor, tenantId)
      const adapter = adapterFor(input.adapter)
      if (tenantId !== null) {
        const pol = await store.tenantPolicy(tenantId)
        if (!pol.byok || pol.byok === 'off' || pol.byok === 'platform_only') throw forbidden('BYOK is not enabled for this tenant')
        if (input.allowPrivateNetwork) throw badRequest('private_network_forbidden', 'Tenant connections cannot use private networks')
      }
      if (input.allowPrivateNetwork && !adapter.descriptor.supportsPrivateNetwork) throw badRequest('private_network_unsupported', `${input.adapter} does not support private hosts`)
      if (!isDataPolicy(input.dataPolicy)) throw badRequest('data_policy_invalid', 'dataPolicy is incomplete')
      if (input.dataPolicy.selfHosted && tenantId === null && !input.allowPrivateNetwork && !input.baseUrl) throw badRequest('data_policy_invalid', 'self-hosted connections need a base URL')
      const baseUrl = input.baseUrl ?? adapter.descriptor.defaultBaseUrl
      if (!baseUrl) throw badRequest('base_url_required', `${input.adapter} needs a base URL`)
      const allowPrivate = tenantId === null && !!input.allowPrivateNetwork
      const check = checkBaseUrl(baseUrl, { requireHttps: !allowPrivate, allowPrivateNetwork: allowPrivate })
      if (!check.ok) throw badRequest('base_url_rejected', check.reason)
      if (adapter.descriptor.requiresApiKey && !input.apiKey) throw badRequest('api_key_required', `${input.adapter} requires an API key`)
      const secret = input.apiKey ? await secrets.put(tenantId, input.apiKey) : null
      const id = newId()
      await o.system.query(
        `insert into platform.ai_connections (id, tenant_id, scope, adapter, name, base_url, allow_private_network, data_policy, enabled_capabilities, enabled_models, secret_id, timeout_ms, infra_cost)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, tenantId, tenantId ? 'tenant' : 'platform', input.adapter, input.name, input.baseUrl ?? null, allowPrivate, JSON.stringify(input.dataPolicy),
          input.enabledCapabilities ? JSON.stringify(input.enabledCapabilities) : null, input.enabledModels ?? null, secret?.id ?? null, input.timeoutMs ?? 60000,
          input.infraCost ? JSON.stringify(input.infraCost) : null])
      await audit(actor, tenantId, 'ai.connection.created', 'ai_connection', id, { adapter: input.adapter, name: input.name })
      return publicConnection((await store.connection(id))!, secret)
    },

    async listConnections(actor: Actor, tenantId: string | null) {
      assertScope(actor, tenantId)
      const rows = await store.connections({ tenantId })
      return Promise.all(rows.map(async (c) => publicConnection(c, c.secret_id ? await secrets.info(c.secret_id) : null)))
    },

    async getConnection(actor: Actor, id: string) {
      const c = await store.connection(id)
      if (!c) throw notFound('Connection')
      assertScope(actor, c.tenant_id)
      return c
    },

    async rotateKey(actor: Actor, id: string, apiKey: string) {
      const c = await admin.getConnection(actor, id)
      const info = c.secret_id ? await secrets.rotate(c.secret_id, c.tenant_id, apiKey) : await secrets.put(c.tenant_id, apiKey)
      await o.system.query(`update platform.ai_connections set secret_id = $2, status = 'untested', version = version + 1, updated_at = now() where id = $1`, [id, info.id])
      await audit(actor, c.tenant_id, 'ai.connection.key_rotated', 'ai_connection', id, { fingerprint: info.fingerprint })
      return { fingerprint: info.fingerprint, last4: info.last4 }
    },

    async setConnectionEnabled(actor: Actor, id: string, enabled: boolean) {
      const c = await admin.getConnection(actor, id)
      await o.system.query('update platform.ai_connections set enabled = $2, version = version + 1, updated_at = now() where id = $1', [id, enabled])
      await audit(actor, c.tenant_id, enabled ? 'ai.connection.enabled' : 'ai.connection.disabled', 'ai_connection', id)
    },

    /**
     * Record a reviewed data policy (e.g. after the provider's terms were checked and ZDR enabled).
     * Audited with the before/after values, because it changes which data classes may be routed here.
     */
    async setDataPolicy(actor: Actor, id: string, dataPolicy: DataPolicy) {
      if (!isDataPolicy(dataPolicy)) throw badRequest('data_policy_invalid', 'dataPolicy is incomplete')
      if (dataPolicy.termsVerified && !dataPolicy.sourceOfTerms?.trim()) throw badRequest('data_policy_invalid', 'termsVerified requires sourceOfTerms')
      const c = await admin.getConnection(actor, id)
      await o.system.query('update platform.ai_connections set data_policy = $2, version = version + 1, updated_at = now() where id = $1', [id, JSON.stringify(dataPolicy)])
      await audit(actor, c.tenant_id, 'ai.connection.data_policy_changed', 'ai_connection', id, { before: c.data_policy, after: dataPolicy })
      return { id, dataPolicy }
    },

    async testConnection(actor: Actor, id: string) {
      const c = await admin.getConnection(actor, id)
      const result = await adapterFor(c.adapter).testConnection(await resolveConnection(c))
      await o.system.query('update platform.ai_connections set status = $2, last_test = $3, updated_at = now() where id = $1', [id, result.ok ? 'ok' : 'failing', JSON.stringify({ ...result, at: new Date().toISOString() })])
      await audit(actor, c.tenant_id, 'ai.connection.tested', 'ai_connection', id, { ok: result.ok })
      return result
    },

    /** List the provider's models and record them as `discovered` (not routable until approved and probed). */
    async discoverModels(actor: Actor, id: string): Promise<DiscoveredModel[]> {
      const c = await admin.getConnection(actor, id)
      const adapter = adapterFor(c.adapter)
      if (!adapter.listModels) throw new GatewayError('unsupported_capability', `${c.adapter} does not support model discovery`)
      const models = await adapter.listModels(await resolveConnection(c))
      for (const m of models) {
        const declared = normalizeCapabilities({ ...m.capabilitiesHint, operations: m.operationsHint ?? [], contextWindow: m.contextWindow ?? null, maxOutputTokens: m.maxOutputTokens ?? null })
        await o.system.query(
          `insert into platform.ai_models (adapter, model_id, display_name, origin, approved, declared, source_url, source_date)
           values ($1,$2,$3,'discovered',false,$4,$5,current_date) on conflict (adapter, model_id) do nothing`,
          [c.adapter, m.id, m.displayName ?? m.id, JSON.stringify(declared), `discovery:${c.id}`])
      }
      await audit(actor, c.tenant_id, 'ai.models.discovered', 'ai_connection', id, { count: models.length })
      return models
    },

    /** Approve a model for use, with admin-declared capabilities and their source (documentation URL). */
    async approveModel(actor: Actor, input: { adapter: string; modelId: string; declared: Partial<Capabilities>; sourceUrl?: string; lifecycle?: string; retiresAt?: string }) {
      if (!actor.isPlatformAdmin) throw forbidden('Approving models requires a platform admin')
      adapterFor(input.adapter)
      await o.system.query(
        `insert into platform.ai_models (adapter, model_id, display_name, origin, approved, declared, source_url, source_date, lifecycle, retires_at)
         values ($1,$2,$2,'admin',true,$3,$4,current_date,$5,$6)
         on conflict (adapter, model_id) do update set approved = true, declared = excluded.declared, source_url = excluded.source_url,
           source_date = excluded.source_date, lifecycle = excluded.lifecycle, retires_at = excluded.retires_at`,
        [input.adapter, input.modelId, JSON.stringify(normalizeCapabilities(input.declared)), input.sourceUrl ?? null, input.lifecycle ?? 'ga', input.retiresAt ?? null])
      await audit(actor, null, 'ai.model.approved', 'ai_model', `${input.adapter}/${input.modelId}`)
    },

    async createDeployment(actor: Actor, input: { connectionId: string; modelId: string; pricing?: Pricing }) {
      const c = await admin.getConnection(actor, input.connectionId)
      const m = await o.system.query<{ declared: Capabilities; approved: boolean }>('select declared, approved from platform.ai_models where adapter = $1 and model_id = $2', [c.adapter, input.modelId])
      if (!m.rows[0]?.approved) throw badRequest('model_not_approved', `Model ${c.adapter}/${input.modelId} is not approved in the registry`)
      const declared = narrow(normalizeCapabilities(m.rows[0].declared), c.enabled_capabilities)
      const id = newId()
      try {
        await o.system.query(
          `insert into platform.ai_deployments (id, tenant_id, connection_id, model_id, declared, pricing) values ($1,$2,$3,$4,$5,$6)`,
          [id, c.tenant_id, c.id, input.modelId, JSON.stringify(declared), input.pricing ? JSON.stringify(input.pricing) : null])
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          const existing = (await o.system.query<{ id: string }>('select id from platform.ai_deployments where connection_id = $1 and model_id = $2', [c.id, input.modelId])).rows[0]
          throw new AppError('deployment_exists', `This connection already has a deployment of ${input.modelId}`, { status: 409, details: { deploymentId: existing?.id ?? null } })
        }
        throw e
      }
      await audit(actor, c.tenant_id, 'ai.deployment.created', 'ai_deployment', id, { model: input.modelId })
      return (await store.deployment(id))!
    },

    /** Run capability probes; stores the verified capability set used by production routing. */
    async probeDeployment(actor: Actor, deploymentId: string) {
      const d = await store.deployment(deploymentId)
      if (!d) throw notFound('Deployment')
      const c = await admin.getConnection(actor, d.connection_id)
      const report = await probeDeployment(adapterFor(c.adapter), await resolveConnection(c), d.model_id, d.declared)
      await o.system.query('update platform.ai_deployments set verified = $2, verified_at = now(), probe_report = $3 where id = $1',
        [deploymentId, JSON.stringify(report.verified), JSON.stringify({ checks: report.checks, adapterVersion: adapterFor(c.adapter).descriptor.version })])
      await audit(actor, c.tenant_id, 'ai.deployment.probed', 'ai_deployment', deploymentId, { ok: report.checks.filter((x) => x.ok).length, failed: report.checks.filter((x) => !x.ok).length })
      return report
    },

    /** Validate and save a route. Rejected with specific reasons if any candidate is ineligible for any task it would serve. */
    async setRoute(actor: Actor, input: { tenantId?: string | null; target: string; environment?: string; candidates: RouteCandidate[] }) {
      const tenantId = input.tenantId ?? null
      assertScope(actor, tenantId)
      const environment = input.environment ?? o.environment
      const m = /^(task|category):([a-z0-9_.-]+)$/.exec(input.target)
      if (!m) throw badRequest('route_target_invalid', 'target must be task:<id> or category:<name>')
      const served = m[1] === 'task' ? [tasks.get(m[2]!)].filter((t): t is TaskDefinition => !!t) : tasks.inCategory(m[2]!)
      if (!served.length) throw badRequest('route_target_unknown', `no registered task matches ${input.target}`)
      if (!input.candidates.length) throw badRequest('route_empty', 'a route needs at least one candidate')
      const ctx: RoutingContext = { ...routingCtx, environment }
      const problems: { deploymentId: string; taskId: string; reasons: string[] }[] = []
      const policy = tenantId ? await store.tenantPolicy(tenantId) : {}
      for (const task of served) {
        if ((task.requires.operation === 'embed' || task.determinism === 'pinned') && input.candidates.length > 1) {
          problems.push({ deploymentId: '*', taskId: task.id, reasons: ['embedding and pinned tasks take exactly one candidate'] })
        }
        for (const cand of input.candidates) {
          const dep = await store.deployment(cand.deploymentId)
          const conn = dep ? await store.connection(dep.connection_id) : null
          if (tenantId === null && conn?.tenant_id) problems.push({ deploymentId: cand.deploymentId, taskId: task.id, reasons: ['platform routes cannot use tenant (BYOK) connections'] })
          const { reasons } = await candidateIssues(ctx, task, tenantId, policy, dep, conn)
          if (reasons.length) problems.push({ deploymentId: cand.deploymentId, taskId: task.id, reasons })
        }
      }
      if (problems.length) throw new AppError('route_invalid', 'Route rejected: ' + problems.map((p) => `${p.taskId} @ ${p.deploymentId}: ${p.reasons.join('; ')}`).join(' | '), { status: 422, details: { problems } })
      const id = await o.system.tx(async (tx) => {
        const prev = await tx.query<{ version: number }>(
          `update platform.ai_routes set active = false where tenant_id is not distinct from $1 and target = $2 and environment = $3 and active returning version`, [tenantId, input.target, environment])
        const rid = newId()
        await tx.query(
          `insert into platform.ai_routes (id, tenant_id, scope, target, environment, candidates, version, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [rid, tenantId, tenantId ? 'tenant' : 'platform', input.target, environment, JSON.stringify(input.candidates), (prev.rows[0]?.version ?? 0) + 1, actor.userId])
        return rid
      })
      await audit(actor, tenantId, 'ai.route.set', 'ai_route', id, { target: input.target, environment, candidates: input.candidates.map((c) => c.deploymentId) })
      return { id }
    },

    async recordEvalStanding(actor: Actor, input: { taskId: string; deploymentId: string; evalRunId: string; passed: boolean }) {
      if (!actor.isPlatformAdmin) throw forbidden('Recording eval standings requires a platform admin')
      await o.system.query(
        `insert into platform.ai_eval_standings (task_id, deployment_id, eval_run_id, passed) values ($1,$2,$3,$4)
         on conflict (task_id, deployment_id) do update set eval_run_id = excluded.eval_run_id, passed = excluded.passed, recorded_at = now()`,
        [input.taskId, input.deploymentId, input.evalRunId, input.passed])
      await audit(actor, null, 'ai.eval_standing.recorded', 'ai_deployment', input.deploymentId, { taskId: input.taskId, passed: input.passed })
    },

    async setBudget(actor: Actor, input: { tenantId: string; moduleId?: string | null; currency: string; monthlyHardLimitMicros: number; monthlySoftLimitMicros?: number }) {
      assertScope(actor, input.tenantId)
      await o.system.query(
        `insert into platform.ai_budgets (id, tenant_id, module_id, currency, monthly_hard_limit_micros, monthly_soft_limit_micros) values ($1,$2,$3,$4,$5,$6)
         on conflict (tenant_id, module_id) do update set currency = excluded.currency, monthly_hard_limit_micros = excluded.monthly_hard_limit_micros, monthly_soft_limit_micros = excluded.monthly_soft_limit_micros`,
        [newId(), input.tenantId, input.moduleId ?? null, input.currency, input.monthlyHardLimitMicros, input.monthlySoftLimitMicros ?? null])
    },

    async usage(actor: Actor, tenantId: string, from: Date, to: Date) {
      assertScope(actor, tenantId)
      return usageSummary(o.system, tenantId, from, to)
    },
  }

  /**
   * The deployment a task would use for this tenant right now (no model call, no metering). Used to
   * key caches by the exact model so a routing change can never serve stale vectors.
   */
  async function currentRoute(taskId: string, ctx: Pick<CallContext, 'tenantId'>): Promise<{ deploymentId: string; adapter: string; modelId: string } | null> {
    const task = tasks.get(taskId)
    if (!task) return null
    const { eligible } = await resolveCandidates(routingCtx, task, ctx.tenantId, await store.tenantPolicy(ctx.tenantId))
    const c = eligible[0]
    return c ? { deploymentId: c.deployment.id, adapter: c.connection.adapter, modelId: c.deployment.model_id } : null
  }

  /** Speech-to-text with routing, retries, eligible-only fallback and metering (duration recorded as latency; no token usage). */
  async function transcribe(taskId: string, req: TranscribeRequest, ctx: CallContext): Promise<TranscribeResult & { route: RouteInfo }> {
    return withSpan(`ai.transcribe ${taskId}`, async () => {
      const { task, candidates } = await prepare(taskId, ctx, 'transcribe')
      let attempt = 0
      let lastErr: unknown
      for (const [i, c] of candidates.entries()) {
        const adapter = adapterFor(c.connection.adapter)
        if (!adapter.transcribe || breakerOpen(c.deployment.id)) continue
        const conn = await resolveConnection(c.connection)
        for (let r = 0; r <= retries; r++) {
          attempt++
          const start = performance.now()
          try {
            const out = await adapter.transcribe(conn, c.deployment.model_id, req, ctx.signal)
            breakerRecord(c.deployment.id, true)
            await meter(task, ctx, c, attempt, i > 0, start, { status: 'ok', usage: out.usage })
            return { ...out, route: { deploymentId: c.deployment.id, connectionId: c.connection.id, adapter: c.connection.adapter, modelId: c.deployment.model_id, attempt, fallback: i > 0 } }
          } catch (e) {
            const err = e instanceof GatewayError ? e : new GatewayError('provider_error', (e as Error).message)
            lastErr = err
            await meter(task, ctx, c, attempt, i > 0, start, { status: 'error', errorKind: err.kind })
            if ((err.retryable || err.fallbackEligible) && err.kind !== 'rate_limited') breakerRecord(c.deployment.id, false)
            const wait = retryWait(err, r + 1)
            if (err.retryable && r < retries && wait !== null) { await new Promise((res) => setTimeout(res, wait)); continue }
            if (!err.fallbackEligible) throw err
            break
          }
        }
      }
      throw lastErr ?? new GatewayError('unsupported_capability', `no deployment for ${taskId} supports transcription`)
    })
  }

  return { tasks, run, stream, embed, transcribe, admin, store, currentRoute }
}

export type Gateway = ReturnType<typeof createGateway>
export type { DeploymentRow }
