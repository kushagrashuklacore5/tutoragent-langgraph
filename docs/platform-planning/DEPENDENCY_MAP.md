# Dependency Map, Boundaries and Ownership

Updated 2026-11-16 · **[Proposed]** · Enforced by CI (PD-12).

## 1. Layers (arrows = "may import")

```
apps/api · apps/worker · apps/web
   │  (imports packages/* directly; imports modules ONLY via generated registry file)
   ▼
modules/<vertical>/<agent>  ──►  modules/<vertical>/shared   (same vertical only)
   │
   ▼  public entry points only
packages layer 3:  ai-evals · ui · testing
packages layer 2:  ai-gateway · documents · retrieval · events
packages layer 1:  identity · audit · jobs · observability
packages layer 0:  core · contracts · tenancy-db
packages/ai-adapters/*  ◄── loaded ONLY via the generated adapter registry inside ai-gateway
packages/ai-adapter-kit ◄── imported only by ai-adapters/*
services/math-solver    ◄── reached over HTTP by a client in packages/ (math-client) — not imported
```

A package may import only from a **lower** layer (or the same layer when listed below).

| Package | May import |
|---|---|
| core | — |
| contracts | core |
| tenancy-db | core |
| observability | core |
| identity, audit, jobs | layer 0, observability |
| events | jobs, layer 0, observability |
| ai-gateway | layer 0–1; `ai-adapters/*` only through `adapters.generated.ts` |
| ai-adapter-kit | core, contracts, observability |
| ai-adapters/<type> | core, contracts, ai-adapter-kit, **its own** vendor SDK; never another adapter |
| documents | layer 0–1, ai-gateway (OCR/parse tasks later) |
| retrieval | layer 0–1, ai-gateway (embeddings), documents |
| ai-evals | ai-gateway, math-client, core, contracts |
| math-client | core, observability |
| ui | core (browser-safe subset) |
| testing | anything in packages (test-only) |

## 2. Module rules

| # | Rule |
|---|---|
| M1 | A module imports only `packages/*` public entry points, its own files, and `modules/<same-vertical>/shared`. |
| M2 | No module imports another module (including another vertical's `shared`). |
| M3 | No package imports any module. |
| M4 | No vendor AI SDK, vendor hostname or provider model id anywhere except `packages/ai-adapters/<type>` and the model registry/config. |
| M9 | Manifests and module config contain no provider, connection or model fields (schema-enforced). |
| M10 | Adapters never import each other; shared code goes into `ai-adapter-kit`. |
| M5 | Modules touch only their own DB schema; reads of platform tables go through package APIs. |
| M6 | Routes, permissions, jobs, events, UI routes, AI tasks are registered **only** via the manifest, with namespaced ids. |
| M7 | Web code of a module is lazy-loaded; the shell never statically imports module UI. |
| M8 | `apps/*` import modules only through `modules.generated.ts`. |

## 3. Enforcement

| Mechanism | Checks |
|---|---|
| dependency-cruiser (`tooling/dependency-rules.cjs`) | M1–M3, M7, M8, layer table |
| ESLint `no-restricted-imports` + a grep job for vendor hosts and model-id patterns | M4, M10 |
| Manifest schema (no provider/model fields) | M9 |
| package `exports` maps + TS project references | no deep imports; build order |
| Manifest validator (startup + CI) | M6 namespacing, required `data` and `evals` fields |
| Migration linter | M5: migration files may only reference own schema + allowed platform tables |
| Removal matrix (MODULE_REMOVAL_STRATEGY § 4) | runtime independence |
| CODEOWNERS | review by owning team |

All run on every pull request; any violation fails the build. Exceptions require an ADR and an
owner sign-off, recorded in `docs/adr/`.

## 4. Ownership

| Path | Owner (role; names in O-2) | Responsibilities |
|---|---|---|
| `packages/core, contracts, tenancy-db, identity, audit, jobs, events, observability, testing` | Platform team | API stability, migrations, security patches |
| `packages/ai-gateway, ai-adapter-kit, ai-evals` | AI platform owner |
| `packages/ai-adapters/<type>` | AI platform owner (each adapter may get its own maintainer) | Provider adapters, conformance, routing safety, eval framework |
| `packages/documents, retrieval` | Platform team (+ AI platform review) | Ingestion quality, deletion guarantees |
| `packages/ui`, `apps/web` shell | Design-system owner | Tokens, accessibility |
| `modules/education-agents/**` | Education product team | Domain correctness, evals, educator relations |
| `modules/education-agents/tutor-agent/**` | Tutor module owner | Manifest, data inventory, removal readiness, eval gates |
| `modules/recruitment-agents/**` | Recruitment product owner | Docs only until approved |
| `services/math-solver` | AI platform owner | Sandbox security |

Changing a package's public API requires: owner approval, a changelog entry, and green CI for all
enabled modules (the CI already builds every module against the change).
