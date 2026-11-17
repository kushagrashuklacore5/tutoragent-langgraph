# Module Removal Strategy

Updated 2026-11-16 · **[Proposed]** · PD-13

Goal: removing one agent, or a whole vertical, never breaks other modules or shared
infrastructure, and never deletes or orphans customer data by accident.

## 1. Two separate operations

| Operation | What changes | Data |
|---|---|---|
| **Disable** (per tenant or per environment) | Feature flag off / removed from `modules.config.json`. Routes return `404`, nav hidden, jobs not scheduled, subscriptions detached, AI tasks unregistered | **Untouched**, inaccessible to users, still covered by backups and retention |
| **Decommission** (code removal) | Folder deleted after the data steps below are complete | Exported/deleted per policy (§ 3) |

Removing code **never** implicitly drops data. Data removal is an explicit, audited, confirmed run.

## 2. Decommission runbook (per module)
1. Disable in all environments; wait one release.
2. Notify affected tenants with the retention/export plan (contractual notice period).
3. Run `platform module:export <id> --tenant <t>` for tenants that request exports (JSON + files).
4. Run `platform module:purge <id> --confirm <id>` (two-person approval):
   - drain and delete queued jobs `<id>/*`; delete outbox events from `<id>.*`;
   - delete module's object-storage prefix `<tenant>/<id>/` for all tenants;
   - delete retrieval chunks/vectors owned by the module (owner column = `<id>`);
   - delete `ai_operations` rows older than billing retention, keep aggregates;
   - drop schema `<vertical>_<agent>` (final "down" migration kept in the platform repo);
   - remove permission grants `<id>:*` from role assignments; remove module settings rows;
   - write one audit event per tenant (audit rows themselves are platform-owned and retained).
5. Delete the folder and its manifest entry; CI removal matrix must be green.
6. Verify: `platform module:verify-absent <id>` checks no schema, no storage prefix, no chunks, no
   grants, no jobs, no routes → attaches report to the change.

## 3. Data inventory and retention on removal (manifest `data` field)

Each manifest declares every data store it writes and what happens on removal:

| Store | Tutor example | Removal behaviour |
|---|---|---|
| Own schema tables | `education_tutor.*` (sessions, turns, evidence, items, plans, cards) | Export on request → drop schema |
| Object storage prefix | generated notes PDFs | Delete prefix |
| Platform documents uploaded *through* the module | student uploads | **Owned by the uploader**, not the module: kept until the user/tenant deletes or account retention expires |
| Retrieval chunks | chunks tagged `owner=education.tutor` | Delete |
| Audit events | tutor actions | Retained per platform audit retention (contain ids, no content) |
| Metering (`ai_operations`) | tutor task calls | Retained for billing period, then aggregated |
| Backups | all | Expire on normal backup rotation (max 35 days); documented to tenants |

Legal holds override purge: purge refuses to run for a tenant under hold.

## 4. Automated removal tests (CI "removal matrix")

For **each enabled module** and **each vertical**, CI generates a build without it and runs:

| Area | Check |
|---|---|
| Build | `pnpm build` + typecheck for all remaining workspaces |
| Boundaries | dependency rules (nothing referenced the removed code) |
| Migrations | (a) fresh database: all remaining migrations apply; (b) database that previously had the module: remaining migrations still apply, orphan schema tolerated, then purge script drops it cleanly |
| API routes | route table snapshot = full snapshot minus `/api/m/<id>/**`; removed paths return 404 |
| Permissions | registry snapshot minus `<id>:*`; role assignments referencing removed keys are ignored, not errors |
| Jobs | job registry minus `<id>/*`; queued jobs of a removed type go to dead-letter with reason, worker keeps running |
| Events | no remaining subscriber requires a removed topic; optional subscriptions start cleanly; publishers with zero subscribers OK |
| UI routes | route + nav snapshot minus `/app/<vertical>/<agent>/**`; deep links show "not available" page |
| AI tasks | gateway task registry minus `<id>.*`; routing config entries for removed tasks warn, don't crash |
| Behaviour | unit + integration + E2E smoke of every remaining module and of platform flows (sign-in, tenant admin, file upload) |

Plus two fixed cases:
- **Platform only** (all modules removed): app starts, sign-in and admin work.
- **Hello module**: a minimal module added and removed to prove the contract.

Matrix cost control: on pull requests run the matrix for modules touched + platform-only; nightly
run the full matrix.

## 5. Removing a whole vertical
Same as above for each agent in the vertical, then remove `<vertical>/shared` and the vertical
README. The matrix includes "minus vertical" builds for each vertical.
