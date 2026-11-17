# Ek Bharat.AI Platform

Modular monolith for Ek Bharat.AI products. Shared infrastructure lives in `packages/`; independently
removable products live in `modules/<vertical>/<agent>/`. Design and decisions: [`docs/platform-planning/`](docs/platform-planning/README.md).

## Requirements
- Node.js 24+ (TypeScript runs natively; no build step)
- PostgreSQL 17 (a local, isolated dev cluster is managed by `npm run db:up`; set `PG_BIN` if not on the Windows default path)
- Optional: Ollama for local-model conformance (`npm run conformance:live`)

## Quick start
```bash
npm ci
npm run db:up                         # local cluster on 127.0.0.1:54329 (trust auth, dev only)
cp .env.example .env                  # set PLATFORM_MASTER_KEY; then export the variables
npm run migrate
node apps/api/src/cli.ts tenant:create --slug demo-univ --name "Demo University" --admin you@example.com
node apps/api/src/cli.ts platform-admin --email you@example.com
npm run start:api                     # http://localhost:8080
npm run start:worker
```
In development, magic-link emails are written to `platform.dev_mail_outbox`.

## Checks (same as CI)
```bash
npm run check        # lint + boundaries + typecheck + all tests
npm run conformance:live   # adapters against local Ollama and hosted providers (env keys)
```

## Layout
| Path | What |
|---|---|
| `packages/core, observability, tenancy-db, identity, audit, jobs, events` | platform foundation |
| `packages/ai-gateway`, `ai-adapter-kit`, `ai-adapters/*` | universal AI gateway + provider adapters |
| `packages/contracts`, `module-runtime` | module contract and registration |
| `apps/api`, `apps/worker` | deployables (HTTP API, job worker) + operations CLI |
| `modules/examples/*` | reference modules used by the removal matrix |
| `tooling/` | dev DB, registry generation, boundary checker, lint |
| `tests/` | API, removal-matrix and boundary tests |

## Adding an AI provider
Create `packages/ai-adapters/<type>/` implementing `ProviderAdapter`, add it to `ai-adapters.config.json`,
run `node tooling/gen-registries.ts`, and add its protocol to the conformance harness. No module or gateway-core change.

## Adding or removing a module
Add the package to `modules.config.json` and run `node tooling/gen-registries.ts`. To remove: delete the
entry (disables; data kept), then `module:purge <id> --confirm <id>` and `module:verify-absent <id>`.
