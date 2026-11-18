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
