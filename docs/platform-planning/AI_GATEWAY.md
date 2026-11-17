# Universal AI Gateway — Design

Updated 2026-11-16 · **[Proposed — awaiting approval]** · Decision PD-16 · Supersedes
`modules/recruitment-agents/docs/AI_GATEWAY.md` (kept for history).

Goal: any provider or model — hosted, regional, self-hosted or customer-owned — can be added,
removed or switched **without touching any agent, domain module or application code**.

## 1. Hard rules (enforced by CI and at runtime)

| # | Rule | Enforcement |
|---|---|---|
| G1 | Agents and modules call only `@platform/ai-gateway` (`run`, `stream`, `embed`) by **task id** | dependency rules (DEPENDENCY_MAP) |
| G2 | Vendor SDKs, vendor hostnames and vendor-specific request shapes exist **only** in `packages/ai-adapters/<type>/` | dependency-cruiser + import lint + hostname grep |
| G3 | No provider or model is a default in code. Routes come only from configuration | grep for model-id patterns outside registry/config; startup fails without a valid routing config |
| G4 | No task is routed to a model whose **verified** capabilities don't cover the task's requirements | config validation + per-call pre-check |
| G5 | Fallback never selects a model with weaker capabilities, lower eval standing, or a less strict data policy | eligibility function (§ 9) + tests |
| G6 | Provider configuration is separate from agent configuration; manifests declare *needs*, never providers | manifest schema has no provider/model fields |
| G7 | Secrets are write-only, encrypted, never sent to clients, never logged | secret broker + redaction tests (§ 11) |
| G8 | Adding a provider = new adapter package + configuration; zero changes in `modules/**` and zero changes in gateway core | "new adapter" CI test (§ 13.3) |

## 2. Concepts

| Concept | What it is | Where it lives |
|---|---|---|
| **Adapter** | Code that speaks one provider protocol (e.g. `openai`, `anthropic`, `google-gemini`, `groq`, `ollama`, `openai-compatible`) | `packages/ai-adapters/<type>/` |
| **Connection** | A runtime instance of an adapter: base URL, credentials, region, data-policy attributes, enabled capabilities and models. Many connections per adapter (e.g. two Ollama hosts, a tenant's BYOK OpenAI key) | DB `ai_connections` |
| **Model** | A registry entry for an exact provider model id with capabilities, limits, pricing, lifecycle | `packages/ai-gateway/registry/models/*.yaml` + DB `ai_models` |
| **Deployment** | A model *as available on a connection* (verified there) | DB `ai_deployments` |
| **Task** | A module-declared unit of AI work with requirements (operation, capabilities, data class, eval suite) | module `manifest.ts` → `ai.tasks` |
| **Route** | Ordered list of eligible deployments for a task (or task category) + parameters, per environment and optionally per tenant | DB `ai_routes` (versioned) |

## 3. Provider-neutral interface

Operations (each optional per adapter, declared in its descriptor):
`generate`, `stream`, `embed`; extension operations reserved: `rerank`, `transcribe`, `synthesize_speech`
(added to the interface only when a task needs them; same pattern).

```ts
// illustrative — final types live in @platform/ai-gateway
interface GenerateRequest {
  messages: Message[]                       // roles: system | user | assistant | tool
  // content parts: text | image(ref) | document(ref) | tool_result
  tools?: ToolDefinition[]                  // name, description, JSON Schema params
  toolChoice?: 'auto' | 'none' | 'required' | { tool: string }
  responseFormat?: { type: 'text' } | { type: 'json_schema'; schema: JSONSchema; strict: boolean }
  maxOutputTokens: number
  temperature?: number
  reasoning?: 'off' | 'low' | 'medium' | 'high'   // normalised; mapped or rejected per model
  stop?: string[]
  seed?: number
  metadata: { tenantId; moduleId; taskId; traceId; promptVersion }
}
interface GenerateResult {
  content: ContentPart[]; toolCalls: ToolCall[]
  finish: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error'
  usage: { input; output; cachedInput?; reasoning? }   // tokens; missing fields are null, never guessed
  route: { connectionId; adapter; modelId; attempt; fallback: boolean }
}
type StreamEvent =
  | { t: 'start' } | { t: 'text'; delta: string } | { t: 'tool_call_delta'; ... }
  | { t: 'tool_call'; call: ToolCall } | { t: 'usage'; usage } | { t: 'finish'; finish }
  | { t: 'error'; error: GatewayError }
interface EmbedRequest { inputs: string[]; purpose: 'document' | 'query'; dimensions?: number }
interface EmbedResult { vectors: number[][]; model: ModelRef; dimensions: number; usage }
```

**Errors** are normalised: `auth`, `permission`, `rate_limited`, `quota_exhausted`, `overloaded`,
`timeout`, `context_length_exceeded`, `content_filtered`, `invalid_request`,
`unsupported_capability`, `network`, `provider_error`, each with `retryable` and `fallbackEligible`.
Raw provider payloads are kept only in redacted, sampled debug logs.

Structured output: the gateway **always validates** JSON against the task schema, whatever the
model's native support (`strict` / `json_mode` / prompt-only). Invalid → bounded repair retry → typed error.

**Adapter contract**

```ts
interface ProviderAdapter {
  descriptor: { type; version; operations; authSchemes; configSchema; discovery: boolean;
                supportsPrivateNetwork: boolean }
  testConnection(conn: ResolvedConnection): Promise<ConnectionTestResult>
  listModels?(conn): Promise<DiscoveredModel[]>
  probe(conn, modelId, capability): Promise<ProbeResult>   // used for verification (§ 5)
  generate(conn, modelId, req, signal): Promise<GenerateResult>
  stream(conn, modelId, req, signal): AsyncIterable<StreamEvent>
  embed?(conn, modelId, req, signal): Promise<EmbedResult>
}
```

Adapters are stateless, receive decrypted credentials per call from the secret broker (§ 11), never
read environment variables or files, and never log request bodies.

## 4. Adapters (initial set)

| Adapter | Protocol | Notes |
|---|---|---|
| `openai` | OpenAI API | Vendor SDK or HTTP, inside the adapter only |
| `anthropic` | Anthropic API | Vendor SDK or HTTP, inside the adapter only |
| `google-gemini` | Gemini API | Vendor SDK or HTTP, inside the adapter only |
| `groq` | Groq API | Separate adapter (own errors, limits, model list), may reuse kit's OpenAI-compatible core internally |
| `ollama` | Ollama native API | Configurable host URL; discovery of locally available models; no automatic model pulls |
| `openai-compatible` | Generic OpenAI-style chat/embeddings | For vLLM, LM Studio, other compatible servers; capabilities are **never assumed** — probing required |

Exact endpoint behaviours (discovery endpoints, structured-output modes, tool-calling, usage fields)
are **[Assumption]** until confirmed by each adapter's conformance run — documentation alone is
not accepted as verification.

Shared adapter helpers live in `packages/ai-adapter-kit` (HTTP client with timeouts and abort,
SSE/NDJSON parsers, error-classification helpers, redaction, OpenAI-compatible core, test harness).
The kit contains no vendor SDKs.

**Adding a provider:** create `packages/ai-adapters/<type>/` implementing `ProviderAdapter`, add
`adapter.manifest.ts`, pass conformance, list it in `ai-adapters.config.json`, add registry
entries. The adapter registry is generated (like modules); gateway core is not edited.

## 5. Model registry

Each entry (`<adapter>/<exact model id>`):

| Field | Notes |
|---|---|
| `modelId` | Exact string accepted by the provider. **Never guessed** — from the provider's list endpoint or official docs (URL + date recorded) |
| `displayName`, `family`, `lifecycle` | `preview` / `ga` / `deprecated` (+ retirement date) |
| `operations` | generate, stream, embed, … |
| `capabilities` | `structuredOutput: strict | json_mode | none` · `tools: none | single | parallel` · `forcedToolChoice` · `vision` · `documents` · `reasoningControl` · `promptCaching` · `embeddingDimensions[]` · `languagesEvaluated[]` |
| `limits` | context window, max output tokens, max embedding batch |
| `pricing` | per-unit prices with currency, effective date, source URL; `null` for local models (optional infra cost rate per connection) |
| `verification` | per capability: `declared` (doc source) or `verified` (probe passed on a named connection, date, adapter version) |

Rules
- Production routes require **verified** capabilities on that deployment; `declared` is enough only
  for development environments.
- **Discovery** (`listModels`) creates `discovered` entries: visible to admins, not routable until
  an admin approves them and probes pass.
- Registry changes are reviewed PRs (curated YAML) or audited admin actions (DB overrides).
- Deprecation dates trigger alerts 30 days ahead for every route using the model.

## 6. Connections (runtime configuration)

| Field | Notes |
|---|---|
| `scope` | `platform` or `tenant` (BYOK, § 12) |
| `adapter`, `name`, `baseUrl` | base URL validated (§ 11.3) |
| `secretRef` | reference into the secret store; never the key itself |
| `region` / `processingLocation` | as stated in verified terms (V-1) |
| `dataPolicy` | `retentionDays`, `zeroRetention`, `trainsOnData`, `dpaInPlace`, `sourceOfTerms` (URL + date) |
| `enabledCapabilities`, `enabledModels` | allowlists (admins can restrict below what the provider offers) |
| `status`, `lastTest` | from connection tests |

Managed by platform admins through an admin API/UI (and tenant admins for BYOK later). Every change
is audited and versioned; routes referencing a disabled connection fail validation loudly.

## 7. Connection testing and discovery
- **Test**: authenticate, minimal generate (and embed if enabled), measure latency, classify errors;
  never echoes credentials. Run on create/update, on demand, and every 15 min for active connections
  (health feeds routing).
- **Discover**: where the adapter supports it, list models → diff against registry → admin review.
- **Probe**: per model, run capability probes (structured output, tool call, forced tool, streaming
  order, embedding dimensions, max-context smoke) → mark capabilities `verified` for that deployment.

## 8. Tasks and routing

**Task definition** (in the module manifest — module owns *needs*, not providers):

```ts
{ id: 'education.tutor.socratic_turn', category: 'tutoring', operation: 'stream',
  requires: { structuredOutput: 'json_mode+', tools: 'none', minContext: 32000, languages: ['en','hi','hinglish'] },
  dataClass: 'student_content',          // drives data-policy eligibility
  determinism: 'flexible',               // 'pinned' for grading/scoring tasks
  fallback: 'eligible_only',             // 'none' | 'eligible_only'
  evalSuite: 'tutor/socratic', latencyClass: 'interactive', outputSchema: ... }
```

Categories (configurable list): `tutoring`, `reasoning`, `embeddings`, `document_processing`,
`assessment`, `classification`, `summarisation`.

**Routes** (platform config + optional tenant overrides) map a task id **or** a category to an
ordered candidate list of deployments with parameters. Resolution order: tenant task route →
tenant category route → platform task route → platform category route → error (no implicit default).

**Validation** (at config save, at startup, and per call):
1. Deployment exists, connection healthy and enabled for the tenant.
2. Verified capabilities ⊇ task requirements; context limit ≥ requirement.
3. Data policy: connection satisfies the task's `dataClass` rules **and** the tenant policy
   (allowed regions/locations, zero-retention required?, no training on data, DPA required).
4. Eval standing: a passing eval run for this task on this deployment (production only).
5. Embedding tasks: dimensions match the index the task writes to (§ 9.3).
Invalid routes cannot be saved; a running system that becomes invalid (e.g. connection disabled)
returns a typed `no_eligible_route` error and alerts — it never improvises.

## 9. Fallback

1. Triggered only by `fallbackEligible` errors (rate limit, overload, timeout, provider error, network).
2. Candidates come **only** from the route's ordered list; each must independently pass all § 8
   validations for this task and tenant. A candidate with weaker capabilities, no passing eval,
   or a less strict data policy is skipped, not "best effort".
3. **Embeddings never fall back** to a different model (vectors are not comparable); they retry the
   same deployment or fail.
4. `determinism: 'pinned'` tasks (grading, scoring) never fall back to a different model.
5. Every fallback is recorded (`ai_operations.fallback = true`), counted in metrics and alerted above a threshold.
6. Circuit breaker per deployment (open after N failures, half-open probes).

## 10. Metering, usage and cost
- One `ai_operations` row per attempt: tenant, module, task, route version, connection, adapter,
  model, prompt version, tokens (input/output/cached/reasoning — null if the provider doesn't report),
  time-to-first-token, total latency, status/error class, fallback flag, BYOK flag, cost (computed
  from the pricing version in force; local models use the connection's infra rate), trace id.
- Aggregations by provider, model, task, module, tenant, day; dashboards; per-tenant and per-module
  budgets with soft alerts and hard caps (hard cap → typed `budget_exceeded` error).
- BYOK usage is metered and shown but never billed as provider cost by us.

## 11. Security

### 11.1 Secret management
- Keys stored as **envelope-encrypted** secrets: a per-scope data key (platform or tenant) encrypts the
  secret; the data key is wrapped by a cloud KMS key in the India region. Ciphertext in DB table
  `ai_secrets` (or the cloud secret manager — decided in F12), never in config files or env for
  connections created at runtime. Bootstrap platform keys may come from the secret manager.
- **Write-only API**: keys can be set or rotated, never read back; UI shows fingerprint + last 4.
- Decryption only inside the gateway process at call time; plaintext held in memory for a short TTL;
  never passed to modules, never serialised, never sent to the browser.
- Audit: create, rotate, delete, test; usage audited as aggregates.

### 11.2 Redaction
Central redactor removes known secrets (exact values from the broker), `Authorization` headers and
common key patterns from logs, traces, error messages and stored provider payloads. Tested (§ 13).

### 11.3 Base URLs and SSRF
- Platform-scope connections may use private-network hosts (needed for Ollama/self-hosted) only with
  an explicit `allowPrivateNetwork` flag set by a platform admin.
- Tenant-scope (BYOK) connections: HTTPS only, public hosts only, DNS resolved and re-checked against
  private/link-local/metadata ranges at call time (prevents DNS rebinding); no redirects followed.
- Egress allowlist at network level for the API/worker hosts.

### 11.4 Data policy
Tenant policy declares allowed processing locations, zero-retention requirement, training prohibition
and DPA requirement; enforced by § 8 validation. Until verification task V-1 completes for a provider,
its connections carry `dataPolicy.sourceOfTerms = unverified` and are **ineligible** for
`student_content` data class in production.

## 12. BYOK (future, designed now)
- Tenant admins create tenant-scope connections with their own keys; encrypted with the tenant's data key.
- **Isolation:** a tenant-scope connection is usable only for that tenant's requests (enforced in the
  resolver and by RLS on `ai_connections`, `ai_secrets`, `ai_routes`); platform connections are usable
  by a tenant only if its policy allows.
- Tenant policy chooses: BYOK-only, BYOK-preferred (platform fallback allowed if eligible), or platform-only.
- Revocation is immediate (cache invalidation); key validation via connection test before activation.

## 13. Testing

### 13.1 Adapter contract (conformance) suite — same suite for every adapter
Runs in three modes: **recorded** (HTTP fixtures, deterministic, every PR), **local** (Ollama container
with a small model, every PR), **live** (real providers, nightly + before release, spend-capped).

| Group | Checks |
|---|---|
| Generation | basic text; system prompt honoured; max tokens → `finish: length`; Unicode/Devanagari round-trip |
| Streaming | event order (`start` … `finish`), cancellation via abort, usage event, no lost deltas |
| Structured output | schema-valid JSON for each supported mode; adapter reports its mode truthfully |
| Tools | single call round trip; forced tool choice; parallel calls (if declared); tool result continuation |
| Embeddings | dimensions match registry; batch limits; deterministic for same input (tolerance) |
| Errors | 401/403, 429, 5xx, timeout, context overflow, content filter → correct normalised error + flags |
| Capability truthfulness | each declared capability passes its probe; an undeclared capability returns `unsupported_capability` (no garbage output) |
| Discovery | `listModels` shape (if supported) |
| Security | no secret in logs, errors or recorded fixtures; no request body logging |
| Usage | token fields present or explicitly null |

### 13.2 Gateway core tests
Routing resolution order; validation rejects capability gaps, data-policy violations, missing eval,
embedding-dimension mismatch; fallback never selects ineligible candidates (property tests over
generated route/capability combinations); pinned tasks never fall back; budgets; circuit breaker;
tenant isolation of connections/secrets/routes.

### 13.3 Provider-switching tests (agent invariance)
1. **Business logic is provider-free:** module unit/integration tests run against the deterministic
   fake adapter; CI fails if module tests import any real adapter.
2. **Config-only switch:** CI job runs each module's integration + E2E smoke suite under a route
   matrix (fake, and each live/recorded adapter that is eligible for the task); the job asserts the
   only changed inputs are routing config files — `git diff` over `modules/**` and gateway core is empty.
3. **Same behaviour contract:** for every task, schema-valid output, same orchestrator states, same
   persisted shapes under every route in the matrix; quality differences show up in eval reports,
   not as failures of business logic.
4. **New-adapter test:** a fixture adapter (`acme`) is added in CI, registered via config, passes
   conformance and serves a hello task — with zero changes outside `packages/ai-adapters/acme/` and config.
5. **Removal test:** disabling any one adapter leaves platform and modules green (routes using it
   fail validation clearly; others unaffected).

## 14. Data model (platform schema)

| Table | Key fields |
|---|---|
| `ai_adapters` | type, version, enabled (mirrors generated registry) |
| `ai_connections` | id, scope, tenant_id?, adapter, name, base_url, allow_private_network, region, data_policy (jsonb), enabled_capabilities, enabled_models, secret_id, status, last_test_at, last_test_result, version |
| `ai_secrets` | id, scope, tenant_id?, ciphertext, wrapped_data_key_ref, fingerprint, last4, created_by, rotated_at |
| `ai_models` | adapter, model_id, display_name, lifecycle, operations, capabilities, limits, pricing_version_id, source_url, source_date |
| `ai_model_pricing` | id, adapter, model_id, unit prices, currency, effective_from, source_url |
| `ai_deployments` | connection_id, model_id, verified_capabilities (jsonb with dates), status |
| `ai_routes` | id, scope, tenant_id?, task_id or category, environment, candidates (ordered deployment ids + params), version, created_by |
| `ai_eval_standings` | task_id, deployment_id, eval_run_id, passed, at |
| `ai_operations` | per attempt (§ 10) |
| `ai_budgets` | scope, tenant_id?, module_id?, period, soft_limit, hard_limit |

RLS: tenant-scope rows visible only to that tenant's context; platform rows readable by the gateway
service role only; secrets table readable by the gateway's secret-broker role only.

## 15. Acceptance criteria (foundation)

| ID | Criterion |
|---|---|
| UG-1 | All six adapters pass the conformance suite in recorded mode; Ollama passes in local mode; hosted adapters pass live mode at least once before release |
| UG-2 | A hello task and a Tutor task run on every eligible adapter by routing-config change only; diff over `modules/**` and gateway core is empty (CI) |
| UG-3 | Vendor SDK imports or vendor hostnames outside their adapter fail CI |
| UG-4 | Saving a route with a capability gap, data-policy violation, missing eval standing or embedding-dimension mismatch is rejected with a specific reason |
| UG-5 | Fallback property tests: 0 ineligible selections over ≥ 10,000 generated scenarios; pinned and embedding tasks never switch models |
| UG-6 | Fixture adapter `acme` added with zero changes outside its folder and config |
| UG-7 | Secrets: write-only API; key material absent from DB plaintext, logs, traces, errors, fixtures and client bundles (automated scans) |
| UG-8 | Tenant A cannot use, see or test tenant B's connections, secrets or routes (isolation suite) |
| UG-9 | Tenant BYOK base URL pointing at private, link-local or metadata addresses is rejected, including via DNS rebinding test |
| UG-10 | Every attempt writes an `ai_operations` row with provider, model, tokens (or null), latency, cost, fallback flag |
| UG-11 | Connection test and model discovery work for every adapter that supports them; discovered models are not routable until approved and probed |
