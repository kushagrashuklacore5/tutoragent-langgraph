# Shared Foundation — Implementation Breakdown

Updated 2026-11-16 · **[Proposed]** · Estimates are ranges for 3–4 engineers and are **not
commitments** (PD-15); re-estimated after each work package.

| WP | Work package | Deliverables | Acceptance criteria | Est. |
|---|---|---|---|---|
| F0 | Repository & CI skeleton | `ekbharat-platform` repo, pnpm workspaces, TS project refs, lint/format, CODEOWNERS, CI (lint, typecheck, unit), docs moved from website repo, ADR template | CI green on empty skeleton; planning docs present in `docs/`; website repo has pointer | 3–5 d |
| F1 | Boundaries & module registry | `contracts` manifest types, manifest validator, `gen-module-registry`, dependency-cruiser rules, `hello` module | Deliberate violation PRs (one per rule M1–M10) fail CI; hello module registers routes/perms/jobs/events/UI/AI task | 4–6 d |
| F2 | Data layer | `tenancy-db`: pool, tenant context, RLS helpers, per-schema migration runner, test DB factory; docker-compose Postgres + pgvector | RLS presence test fails on a table without policy; migrations idempotent | 4–6 d |
| F3 | Identity | OIDC + magic link, sessions, users, tenants (institution/individual types), roles, permission registry, **age attestation + 18+ enforcement** (PD-09) | E2E sign-in; under-18 attestation blocked; permission checks on every route (test enumerates routes) | 6–8 d |
| F4 | Audit, observability | append-only audit (DB role cannot UPDATE/DELETE), tracing, PII-scrubbed logs | Audit tamper test; log scrub test with seeded PII | 3–4 d |
| F5 | Jobs & events | Postgres queue, idempotency keys, retries, dead-letter, scheduler, outbox + dispatcher, subscription registry | Kill-worker test completes exactly once; duplicate idempotency key no double effect | 5–7 d |
| F6a | Gateway core | neutral types (generate, stream, tools, structured output, embed), normalised errors, adapter contract + generated adapter registry, `ai-adapter-kit`, fake adapter, structured-output validation/repair, metering (`ai_operations`), budgets, circuit breaker | Fake adapter passes conformance; schema validation + repair tested; every attempt metered | 8–10 d |
| F6b | Registry, connections, secrets | model registry (YAML + DB, verification states, pricing versions, deprecation alerts), connections, deployments, envelope-encrypted write-only secret broker, redaction, base-URL/SSRF guard, connection test, discovery, capability probes, admin API (platform scope; tenant scope behind BYOK flag) | UG-7, UG-8, UG-9, UG-11 (AI_GATEWAY § 15) | 8–12 d |
| F6c | Routing and fallback | task/category routes (versioned), validation (capabilities, data policy, eval standing, embedding dimensions), resolution order, eligible-only fallback, pinned and embedding no-switch rules | UG-4, UG-5 (≥ 10,000 generated scenarios, 0 ineligible selections) | 5–7 d |
| F6d | Adapters + contract suite | conformance suite (recorded / local / live modes); adapters **openai, anthropic, google-gemini, groq, ollama, openai-compatible**; `acme` fixture adapter; provider-switching CI matrix | UG-1, UG-2, UG-3, UG-6, UG-10 | 15–22 d (parallelisable per adapter) |
| F7 | Documents & retrieval | upload, type/size/malware checks, parser (after spike O-4), page maps, chunking, embeddings via gateway, hybrid search, scope filters, deletion | 30 sample PDFs: ≥ 98% page-correct citations on 100 spot checks; delete removes all chunks (count check); cross-tenant search returns nothing | 8–12 d |
| F8 | Math solver sidecar | SymPy service, expression whitelist, limits, `math-client` package | Fuzz: no network access, no arbitrary code execution, 2 s CPU cap enforced; equivalence tests | 4–6 d |
| F9 | AI eval framework | `ai-evals` runner, graders, judge validation, reports, gates, CI workflow | Hello task suite runs on every adapter route with a side-by-side report; failing gate blocks PR | 6–8 d |
| F10 | UI foundation | tokens (light + dark), primitives, Markdown/KaTeX/code renderer, PDF viewer wrapper, app shell, lazy module UI loading | Shell renders hello module UI; axe-core no critical issues; keyboard-only nav | 6–8 d |
| F11 | Module removal machinery | `module:export/purge/verify-absent` commands, removal-matrix CI job, platform-only build | Matrix green for hello + platform-only; purge leaves `verify-absent` clean | 5–7 d |
| F12 | Infra (India region) | IaC for DB, storage, secrets, app hosting; backups; staging env | Restore drill succeeds; secrets only in manager | 5–8 d (O-3) |

Sequence: F0 → F1 → F2 → (F3, F4 in parallel) → F5 → F6a → (F6b, F6c) → F6d (adapters in parallel)
→ (F7, F8, F9 in parallel) → F10 → F11 → F12 (F12 can start after F2). Total foundation estimate:
**≈ 11–15 weeks** (was 8–12; the universal gateway adds ≈ 3 weeks). Estimate, not commitment (PD-15).

Foundation exit criteria = all WP acceptance criteria + security review of identity, RLS, gateway
and solver.

## Implementation status (updated 2026-11-17)

| WP | Status | Evidence |
|---|---|---|
| F0 | Done — npm workspaces (pnpm not installed; same structure), Node 24 native TS, CI workflow | `.github/workflows/ci.yml`, `npm run check` |
| F1 | Done | manifest validator, generated registries, `tests/boundaries.test.ts` (10 planted violations detected) |
| F2 | Done | `packages/tenancy-db`, RLS presence + isolation tests |
| F3 | Done except OIDC/SSO (magic link + sessions + roles + 18+ enforcement) | `packages/identity/test` |
| F4 | Done (in-process metrics/tracing; external exporter pending infra) | `packages/observability`, audit append-only tests |
| F5 | Done (scheduled/recurring jobs not yet) | `packages/jobs/test` incl. crash recovery |
| F6a–c | Done | `packages/ai-gateway/test/gateway.test.ts` (22 tests, 10k-scenario property test) |
| F6d | Done (recorded 92/92 for six adapters; Ollama local 14/14); hosted live runs blocked on keys | `packages/ai-gateway/conformance` |
| F7 | Not started (documents & retrieval; needs pgvector — see blockers) | — |
| F8 | Not started (SymPy sidecar) | — |
| F9 | Partial — conformance + gateway eval-standing gate; dataset runner not built | — |
| F10 | Not started (web shell / UI foundation) | — |
| F11 | Done | `module-runtime/lifecycle.ts`, `tests/removal.test.ts` |
| F12 | Not started (needs O-3 cloud/India region) | — |
