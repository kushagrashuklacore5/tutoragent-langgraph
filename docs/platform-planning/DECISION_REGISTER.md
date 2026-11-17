# Decision Register — Ek Bharat.AI Platform

Updated 2026-11-16 · Owner: product owner · This register **supersedes** decision tables in
`modules/*/docs/*` where they differ.

Status: **Final** = approved by product owner 2026-11-16 · **Open** = still needs input ·
**Verify** = approved direction pending a fact check.

## 1. Final decisions

| ID | Decision | Consequences |
|---|---|---|
| PD-01 | **Dedicated platform repository** (working name `ekbharat-platform`). Reusable infrastructure in `packages/`, independently removable products in `modules/`. The marketing website repo keeps only planning docs until the platform repo exists, then holds a pointer. | Separate access control, CI and deployments from the public website |
| PD-02 | **Modular monolith.** One API process, one worker process, one web app, plus one isolated maths-solver sidecar. No microservices until a measured need (load, team, isolation) is written up as a new decision. | Module boundaries are enforced in code and CI, not by network hops |
| PD-03 | **Tutor Agent is the first product.** Recruitment stays in the architecture (folder, docs, contracts) but is **not implemented in parallel**. | Phase 1 builds the shared foundation + Tutor only |
| PD-04 | **Stack:** TypeScript on Node.js LTS (API, worker, web with React), PostgreSQL (+ pgvector, full-text search), Postgres-backed job queue, S3-compatible object storage, pnpm workspaces. | One language for most code; one database |
| PD-05 | **OpenAI and Anthropic are the first providers evaluated for Tutor production routes.** Revised by PD-16: they are two of six foundation adapters, not the limit of the architecture. **No default provider in code.** | Tutor eval gates run on both first |
| PD-06 | **India-hosted application data** (database, object storage, backups, logs, search indexes). **No inference data-residency commitment** to any customer until each provider's residency, retention and data-use terms are verified in writing (task V-1). | Contracts/DPAs must disclose that inference may be processed outside India until V-1 says otherwise |
| PD-07 | **Deterministic maths engine: SymPy** (or equivalent) in an isolated, no-network container behind a narrow JSON API. | Second runtime (Python) limited to one sidecar |
| PD-08 | **Institution-first pilot.** The tenancy model supports a future "individual" tenant type for direct student subscriptions without schema changes. | Billing and consumer flows deferred |
| PD-09 | **Pilot restricted to students aged 18+.** Under-18 support only after compliance and safeguarding review (DPDP child-data obligations). | Age attestation at sign-up + institution roster confirmation; under-18 accounts blocked |
| PD-10 | **`modules/recruitment` renamed to `modules/recruitment-agents`** (done 2026-11-16; only planning docs referenced the path; links updated). | — |
| PD-11 | **Misleading model labels in the website's Workflow Studio demo fixed as a separate change** in the website repo, not part of the platform work. | Tracked as task W-1; does not block Phase 1 |
| PD-12 | **Enforceable module boundaries and ownership** (DEPENDENCY_MAP.md). Violations fail CI. | — |
| PD-13 | **Module removal is tested automatically** across migrations, API routes, permissions, jobs, event subscriptions, UI routes and gateway tasks; data handling on removal follows MODULE_REMOVAL_STRATEGY.md. | Removal matrix job in CI |
| PD-14 | **Reusable AI evaluation framework** in `packages/ai-evals` covering answer quality, citation accuracy, tutoring effectiveness, latency and cost (AI_EVALUATION_FRAMEWORK.md). | Every AI task ships with a dataset and gates |
| PD-15 | **All timelines are estimates, not commitments**; re-estimated at the end of each work package. | — |
| PD-16 | **Universal, model-agnostic AI Gateway** ([AI_GATEWAY.md](AI_GATEWAY.md)): neutral interface (generate, stream, tools, structured output, embeddings); independent adapters for **OpenAI, Anthropic, Google Gemini, Groq, Ollama and generic OpenAI-compatible** endpoints; extensible adapter registry; central model registry with verified ids, capabilities and limits; runtime connections (provider, key, base URL, models, capabilities); envelope-encrypted write-only secrets; connection tests and discovery; task/category routing with capability, data-policy and eval validation; eligible-only fallback; usage, latency, token and cost metering; local Ollama hosts; BYOK-ready tenant isolation; one contract suite for every adapter; provider-switching invariance tests | Adding a provider never touches modules or gateway core; F6 becomes F6a–F6d and the foundation estimate grows |

## 2. Open items (do not block starting F0–F2)

| ID | Item | Needed by |
|---|---|---|
| O-1 | Pilot institution(s) and 2–3 pilot courses (one maths-heavy, one theory-heavy) | Start of Tutor work package T3 |
| O-2 | Named owners for platform, AI platform and education module (CODEOWNERS) | F0 |
| O-3 | Cloud provider with an India region (for PD-06) | F0 |
| O-4 | Document parser choice — decided by a 1-week spike on real course PDFs | F7 |
| O-5 | Transactional email provider (magic links) | F3 |
| O-6 | Platform repository name and GitHub organisation | F0 |

## 3. Verification tasks

| ID | Task | Owner | Blocks |
|---|---|---|---|
| V-1 | For **every hosted provider before its connections may carry student content** (first OpenAI and Anthropic, then Gemini, Groq and others), obtain and review terms for: processing regions, any India/regional residency options, data retention, zero-data-retention eligibility, training on API data, sub-processors. Record findings with links and dates. | Product owner + counsel | Any residency statement to customers; pilot DPA |
| V-2 | Counsel review: DPDP role (fiduciary vs processor) for institution accounts; adult-only pilot terms | Counsel | Pilot contract |
| V-3 | Confirm each adapter's provider API features the gateway relies on (structured output, tool calling, streaming, embeddings) via the conformance suite — not documentation alone | Engineering | F6 acceptance |

## 4. Superseded decisions
- Recruitment D-1 (`ekbharat-recruitment` own repo) → PD-01 (one platform repo).
- Recruitment D-5 / Tutor D-T2 (providers open) → PD-05, broadened by PD-16.
- `modules/recruitment-agents/docs/AI_GATEWAY.md` → `platform-planning/AI_GATEWAY.md` (PD-16).
- Tutor D-T10 (under-18 with parental consent) → PD-09 (18+ only for pilot).
- Tutor D-T4 (sequencing) → PD-03.
