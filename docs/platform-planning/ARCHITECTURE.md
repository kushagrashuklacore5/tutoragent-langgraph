# Platform Architecture (revised)

Updated 2026-11-16 · Implements PD-01…PD-16 in DECISION_REGISTER.md · **[Proposed — awaiting approval]**

## 1. Shape: a modular monolith

```
                ┌──────────────────────────── apps/web (React SPA) ───────────────────────────┐
                │ shell: auth screens, layout, nav  ←  UI routes/nav from enabled module manifests │
                └───────────────┬──────────────────────────────────────────────────────────────┘
                                │ HTTPS (REST + SSE)
┌────────────── apps/api (Node, one process) ──────────────┐   ┌──── apps/worker (Node) ────┐
│ platform routes: /api/auth, /api/tenants, /api/files, …    │   │ job runner (Postgres queue) │
│ module routes mounted at /api/m/<module-id>/…              │   │ module job handlers          │
│ permission check (identity) → module handler               │   │ event subscribers            │
└──────────────┬─────────────────────────────────────────────┘   └──────────────┬──────────────┘
               │ in-process calls to packages/*                                   │
   ┌───────────┴───────────────────────────────────────────────────────────────────┴──────────┐
   │ packages: identity · tenancy-db · audit · jobs · events · documents · retrieval ·         │
   │           ai-gateway → ai-adapters/* (6 initial) · ai-evals · observability · ui         │
   └───────────┬───────────────────────────────┬───────────────────────────────┬───────────────┘
               │                               │                               │
        PostgreSQL (India)            Object storage (India)          solver sidecar (SymPy,
        RLS · pgvector · FTS          tenant-prefixed keys            no network, JSON API)
```

- **Three deployables + one sidecar**, all built from one repository and one version.
- **Modules are libraries, not services.** The host apps load enabled modules from a generated
  registry (`apps/*/src/modules.generated.ts`) built from module manifests.
- Out-of-process only where isolation demands it: the maths solver (and, later, the code sandbox).

## 2. Module contract (manifest)

Every agent folder contains `manifest.ts` exporting a typed object. The host refuses to start if a
manifest is invalid. Everything a module adds to the platform is declared here — nothing is
registered implicitly.

| Field | Meaning | Namespacing rule |
|---|---|---|
| `id`, `version`, `vertical`, `owner` | Identity and ownership | `id` = `<vertical>.<agent>` e.g. `education.tutor` |
| `db.schema`, `db.migrations` | Own Postgres schema and migration folder | schema `<vertical>_<agent>` e.g. `education_tutor` |
| `api.routes` | Router factory | mounted only under `/api/m/<id>/` |
| `permissions` | Declared permission keys + default role grants | `<id>:<action>` e.g. `education.tutor:session.create` |
| `jobs` | Job types and handlers | `<id>/<job>` |
| `events.publishes` / `events.subscribes` | Event contracts | topics `<id>.<event>.v<n>`; may subscribe to platform topics, own topics, or other modules' topics **only as optional** (see § 4) |
| `ui.routes`, `ui.nav` | Lazy-loaded route tree and nav entries | paths under `/app/<vertical>/<agent>/` |
| `ai.tasks` | Gateway task definitions (schema, capabilities, eval dataset ref) | `<id>.<task>` |
| `settings` | Tenant-level feature flag + module settings schema | stored by platform, keyed by `id` |
| `data` | Data inventory and removal policy (MODULE_REMOVAL_STRATEGY § 3) | required |
| `evals` | Dataset paths + release gates | required for every `ai.tasks` entry |

## 3. Platform packages (shared, no domain logic)

| Package | Responsibility |
|---|---|
| `core` | config loading, typed errors, result types, IDs, clock — zero dependencies on other packages |
| `contracts` | Versioned public types: event envelopes, platform events, manifest types |
| `tenancy-db` | Postgres pool, per-request tenant context, RLS helpers, migration runner (per-schema), test DB factory |
| `observability` | tracing, metrics, PII-scrubbed structured logging |
| `identity` | OIDC + magic link, sessions, users, roles, permission registry and checks, age attestation (PD-09), tenant types (institution / individual, PD-08) |
| `audit` | append-only audit events (no content, ids only) |
| `jobs` | Postgres queue, idempotency keys, retries, dead-letter, scheduled jobs |
| `events` | transactional outbox + dispatcher on top of `jobs`; subscription registry |
| `documents` | upload, type/size checks, malware scan, parsing, page maps, storage, deletion |
| `retrieval` | chunks, embeddings (via gateway), hybrid search, scope/permission filters, deletion |
| `ai-gateway` | universal, provider-neutral interface (generate, stream, tools, structured output, embeddings); model registry; connections; secret broker; task routing with capability + data-policy validation; eligible-only fallback; metering — **full design: [AI_GATEWAY.md](AI_GATEWAY.md)** |
| `ai-adapter-kit` | shared adapter helpers (HTTP/abort, SSE/NDJSON parsing, error classification, redaction, OpenAI-compatible core, conformance harness) — no vendor SDKs |
| `ai-adapters/{openai, anthropic, google-gemini, groq, ollama, openai-compatible}` | the **only** places vendor SDKs, hostnames and protocols appear; each passes the same conformance suite; more can be added without touching gateway core or modules |
| `ai-evals` | evaluation framework (AI_EVALUATION_FRAMEWORK.md) |
| `math-client` | typed HTTP client for the solver sidecar (PD-07) |
| `ui` | design tokens, primitives, Markdown/Math/Code renderer, PDF viewer wrapper |
| `testing` | shared fixtures: tenant/user factories, fake gateway adapter, module-removal harness |

## 4. Communication between modules
- **Default: none.** Agents do not call each other.
- If needed, only via **events** with versioned contracts in the publisher's
  `contracts/` sub-path, consumed through `packages/contracts` re-export. Subscriptions to another
  module's events are declared `optional: true`; the subscriber must work when the publisher is absent
  (removal test enforces this).
- No shared tables between modules; no cross-schema foreign keys except to platform tables
  (`tenants`, `users`, `documents`).

## 5. Data
- PostgreSQL in an India region: `platform` schema (tenants, users, roles, audit, jobs, outbox,
  documents, chunks, ai_operations) + one schema per module.
- RLS on every tenant-scoped table, in every schema; app role has no `BYPASSRLS`.
- Object storage keys: `<tenant>/<module-id|platform>/<object>` → module data is findable for deletion.
- Backups in-region; restore tested quarterly.

## 6. AI usage rules (summary; details in [AI_GATEWAY.md](AI_GATEWAY.md))
- Modules call `gateway.run / stream / embed(taskId, input, ctx)` only, and declare **needs**
  (operation, capabilities, data class, eval suite) in their manifest, never providers or models.
- Provider configuration (connections, keys, base URLs, enabled models/capabilities) is runtime
  platform/tenant configuration managed by admins, separate from agent configuration.
- Routes map tasks or task categories to ordered, validated deployments; there is no default model.
- Routing and fallback only select models whose **verified** capabilities, eval standing and data
  policy satisfy the task and tenant; embeddings and pinned (grading) tasks never switch models.
- Six adapters at foundation: OpenAI, Anthropic, Google Gemini, Groq, Ollama, generic
  OpenAI-compatible. Tutor production routes are first evaluated on OpenAI and Anthropic (PD-05);
  others become routable once their conformance and eval gates pass.
- Keys are envelope-encrypted, write-only and decrypted only inside the gateway; BYOK is tenant-isolated.
- Until V-1 is complete for a provider, its connections are ineligible for student content in production (PD-06).

## 7. Website repository
Stays as is. Its `server/` Groq demo endpoints are **not** reused by the platform. Label fix is W-1 (PD-11).
