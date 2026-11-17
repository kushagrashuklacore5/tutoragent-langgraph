# Repository Structure — `ekbharat-platform`

Updated 2026-11-16 · **[Proposed]** · pnpm workspaces; TypeScript project references.

```
ekbharat-platform/
├─ apps/
│  ├─ api/                    HTTP host: platform routes + mounts enabled modules
│  ├─ worker/                 job/event host: runs enabled modules' handlers
│  └─ web/                    React shell: auth, layout, nav; lazy-loads module UIs
├─ packages/                  SHARED INFRASTRUCTURE — never imports from modules/
│  ├─ core/  contracts/  tenancy-db/  observability/
│  ├─ identity/  audit/  jobs/  events/
│  ├─ documents/  retrieval/
│  ├─ ai-gateway/             interface, registry, connections, secret broker, routing, metering
│  │  ├─ registry/models/     curated model YAML (exact ids, capabilities, limits, pricing, sources)
│  │  ├─ conformance/         the one contract suite every adapter must pass
│  │  └─ docs/AI_GATEWAY.md
│  ├─ ai-adapter-kit/         shared adapter helpers (no vendor SDKs)
│  ├─ ai-adapters/            one package per provider protocol
│  │  ├─ openai/  anthropic/  google-gemini/  groq/  ollama/  openai-compatible/
│  │  └─ <new-provider>/      added without touching gateway core or modules
│  ├─ ai-evals/
│  ├─ math-client/            typed client for services/math-solver
│  ├─ ui/
│  └─ testing/                fixtures, fake AI adapter, module-removal harness
├─ services/
│  └─ math-solver/            Python + SymPy sidecar (Dockerfile, JSON API, tests)
├─ modules/                   INDEPENDENTLY REMOVABLE PRODUCTS
│  ├─ education-agents/
│  │  ├─ README.md
│  │  ├─ shared/              created only when a 2nd education agent needs it
│  │  └─ tutor-agent/
│  │     ├─ manifest.ts       the module contract (ARCHITECTURE § 2)
│  │     ├─ README.md         purpose, dependencies, setup, removal
│  │     ├─ OWNERS            (mirrored in CODEOWNERS)
│  │     ├─ domain/           pure logic: learner model, planner, policies (no I/O)
│  │     ├─ api/              route handlers, request schemas
│  │     ├─ worker/           job + event handlers
│  │     ├─ web/              screens and tutor-specific components
│  │     ├─ db/migrations/    schema education_tutor only
│  │     ├─ ai/               gateway task definitions + versioned prompts
│  │     ├─ evals/            datasets + gates (uses packages/ai-evals)
│  │     ├─ contracts/        public event types (only if it publishes events)
│  │     ├─ config/           default settings, feature flags
│  │     ├─ assets/
│  │     ├─ tests/            unit, integration, e2e for this module
│  │     └─ docs/             (moved from this planning set)
│  ├─ recruitment-agents/     docs only until implementation is approved (PD-03)
│  │  ├─ README.md
│  │  └─ docs/
│  └─ healthcare-agents/      created when the first healthcare agent is approved
├─ tooling/
│  ├─ dependency-rules.cjs    dependency-cruiser config (DEPENDENCY_MAP § 3)
│  ├─ gen-module-registry.ts  manifests → apps/*/src/modules.generated.ts
│  └─ removal-matrix.ts       drives MODULE_REMOVAL_STRATEGY § 4 tests
├─ infra/                     IaC (India region), docker-compose for local dev
├─ docs/                      platform docs: architecture, ADRs, decision register, runbooks
├─ .github/
│  ├─ CODEOWNERS
│  └─ workflows/              ci.yml, removal-matrix.yml, evals.yml, security.yml
├─ modules.config.json        which modules are enabled per environment
├─ ai-adapters.config.json    which adapters are compiled in and enabled
├─ pnpm-workspace.yaml
└─ package.json
```

Conventions
- Every workspace package has an `exports` map; deep imports into another package's internals are
  impossible at the resolver level and also flagged by dependency rules.
- `modules.config.json` is the single switch for enabling a module per environment; tenant-level
  enabling is a runtime feature flag on top.
- Planning docs from this website repo (`platform-planning/`, `modules/*/docs/`) are moved in F0;
  the website repo then keeps a one-line pointer README.
