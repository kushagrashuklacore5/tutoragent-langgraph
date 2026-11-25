# education.tutor — AI Personal Tutor

## Purpose
Socratic tutoring grounded in course structure, an evidence-based learner profile, adaptive practice,
FSRS spaced revision and a deterministic study planner. Design: [`docs/`](../../../docs/platform-planning/README.md)
and the planning set in the website repository (`modules/education-agents/tutor-agent/docs`).

## Dependencies
`@platform/contracts`, `@platform/core`, `@platform/tenancy-db` (types). AI only through the gateway task
`education.tutor.socratic_turn` (needs: generate + JSON, student_content). No provider is referenced.

## Setup
1. Add `{ "id": "education.tutor", "package": "@modules/education-tutor-agent" }` to `modules.config.json`, run `node tooling/gen-registries.ts`.
2. `npm run migrate`, then `node apps/api/src/cli.ts tenant:enable-module --slug <tenant> --module education.tutor`.
3. A platform admin configures a connection, approves a model, creates a deployment and routes `category:tutoring` to it.

## Removal
Remove the entry from `modules.config.json` (disables; data kept), then
`module:export education.tutor --slug <tenant>` for each tenant that asks, `module:purge education.tutor --confirm education.tutor`
and `module:verify-absent education.tutor`.

## Status
Implemented: courses/concepts/prerequisites, learner model, Socratic tutor with retrieval, citations and maths checks,
materials and Ask-My-Notes, practice (MCQ/numeric/expression), misconception diagnosis, FSRS revision, planner and recovery,
coach / next-best action, voice input, assessment engine (generation, marking, review, recovery), educator dashboards, and the
agentic study companion (`src/agent/`: onboarding, roadmap proposals with approval, tool registry, background workflows).
Not yet: teach-back, web resource search, server-side speech output.

## Companion orchestration (LangGraph)

The study companion runs as a LangGraph.js `StateGraph` (`src/agent/graph/`), checkpointed in PostgreSQL
(`agent_graph` schema, migration `0019`). One thread per conversation (`<tenant>:<conversation>`, opened only after an
RLS ownership check); one run per student turn, or a resumed run when the thread waits at an interrupt (roadmap
approval, document scope). Subgraphs: document intelligence (`nodes/document.ts`) and course & roadmap planning
(`nodes/planning.ts`, one checkpoint per step). Domain logic stays in the existing services (`profile.ts`, `toolset.ts`,
`courses/*`, `studio/*`, `assessments.ts`, FSRS); nodes only orchestrate them. Checkpoints contain no student text.

Operations: run migrations (`npm run migrate`) before starting the API/worker; both hosts create the checkpointer from
`SYSTEM_DATABASE_URL`. Rollback: redeploy the previous release (commit `8771740`); the `agent_graph` schema can stay
(unused by the old code) or be dropped. Tests: `tests/companion-graph.test.ts` (interrupts, restart, ownership),
`tests/agent.test.ts`, `tests/document-first.test.ts`, `modules/.../tests/graph.unit.test.ts`.
