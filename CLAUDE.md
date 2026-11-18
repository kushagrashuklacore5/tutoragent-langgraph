# Ek Bharat platform — working notes

Node >= 24, TypeScript run directly by Node (`.ts` imports, no build). npm workspaces: `packages/*`, `packages/ai-adapters/*`, `modules/*/*`, `apps/*`.

## Commands (run from repo root)
- DB: `npm run db:up` (local PG17 on 127.0.0.1:54329, data in `.data/pg`). Env in `.env` — load with `set -a; . ./.env; set +a` in bash.
- Typecheck: `npx tsc -p tsconfig.json --noEmit` (web: `npm run typecheck -w @platform/app-web`)
- Unit tests only (fast, no DB): `npm run test:unit`
- One file: `node --test path/to/x.test.ts` (needs `.env` loaded for DB tests)
- Full: `npm run check` (lint + boundaries + typecheck + all tests, needs DB). Use `--test-reporter=dot` and `tail` to keep output small.
- Ollama runs locally on :11434 (embeddings + small chat model). Docker is NOT available.

## Layout
- `apps/api` HTTP host, `apps/worker` jobs host, `apps/web` React+Vite student/educator UI (`src/pages/*`, `src/lib/tutor.ts` client types).
- `packages/ai-gateway` all model calls (tasks declare needs; routing config picks provider). Never call providers directly.
- `packages/documents` upload/parse/scan, `packages/retrieval` chunk/embed/hybrid search, `packages/math-client` SymPy sidecar client (fail closed: only trust `ok === true`).
- `packages/tenancy-db` RLS: all tenant data via `d.inTenant(principal, tx => …)`. `platform.current_tenant()` in SQL.
- `modules/education-agents/tutor-agent` the Tutor: `manifest.ts` routes, `turns.ts` Socratic turn pipeline, `materials.ts` upload/Ask-My-Notes/grounding, `domain/*` pure logic (unit-tested).

## Tutor intelligence & assessment (decisions)
- AI proposes, deterministic code decides: mastery/next action (`domain/learner-model.ts`, `domain/insight.ts`), assembly and marking validation (`domain/assessment.ts`) are pure and unit-tested. Never let a model set a score, mastery or recommendation directly.
- Learner evidence only from validated outcomes: deterministic scores, solver-verified follow-ups, rubric marks that passed `validateMarking` (two passes, quoted evidence, per-criterion agreement), or educator-settled marks. Unsettled marks → `needs_review`, no evidence.
- Educator decisions reach a student's owner-only records only via `education_tutor.record_reviewed_evidence()` (SECURITY DEFINER, checks `teaches(course)`); one evidence row per assessment response, corrected on override.
- Generated questions: approved (educator-verified) material only, validated (`assessgen.ts checkCandidate` + maths check), stored as `status='draft'`; students only ever get `status='approved'` items. Answer keys/rubrics never leave the server before submission.
- AI task categories: `tutoring`, `assessment` (generation + marking), `speech_to_text`, `embeddings`. Groq adapter uses best-effort json_schema (`strictSchema:false`); gateway validates every reply.
- Evals: `node tooling/evals.ts run <suite> --route <cfg>`; run ONE suite at a time (shared eval DB route).
- Marking reliability: submission enqueues `assessment.grade` (job, backoff) in the submit tx; a grading run claims (`grading_attempts`), marks outside any tx, then commits once under `SELECT … FOR UPDATE` — repeated/concurrent runs are no-ops. Transient AI failures (rate limit, overload, timeout) throw `marking_unavailable` → retry, never "needs review". After `MAX_AI_GRADING` runs: deterministic-only marking, written answers → educator review. Sweep `assessment.recover` (5 min) re-enqueues stale attempts via `stale_grading_attempts()`.
- Overrides: written items take criterion marks (total = sum); `grading.original` is immutable, `grading.history` records every change; evidence corrected via `record_reviewed_evidence()`.
- Marking eval: `node tooling/evals.ts run-marking --route <cfg> --dataset <jsonl>`; real data via `export-marking --tenant <id> --out f --confirm-consent`. `source: synthetic` fixtures are pipeline checks, never quality evidence.
- Next-action "confident mistakes" rule uses `calibration.unresolvedSureWrong` (last 10 rated answers, cleared by 3 consecutive confident-correct), not the all-time `sureWrong` count.
- Document parsing runs in a child PROCESS per document (`packages/documents/src/parse.ts`): pdf.js leaks native memory per worker thread and crashed hosts after ~100 PDFs.

## Study companion (agentic layer, `tutor-agent/src/agent/`)
- One orchestrator turn = DECIDE call (intent, stated profile values, doubts, tool requests, draft reply) + optional COMPOSE call from tool results; max 2 model calls per turn, templates if the model fails. Background workflows (`agent.daily.student`, `agent.after_assessment`) make no model calls.
- Model only requests tools; `executeTool` rejects unknown / non-model-callable tools and invalid args, runs each tool as the student in the RLS tx (tools re-check enrolment), with statement timeout, read retries, write idempotency keys and a trace row (`agent_tool_calls`: ids/numbers only, free text digested).
- Approval is never inferred from model output: `plan.apply` is not model-callable; it runs only after the student's button or an explicit approve of the pending proposal, and applies the STORED proposal.
- Onboarding: `profile.ts` decides what to ask (required slots, then at most 2 optional, counting volunteered answers); one question per reply (`oneQuestion`). Planning runs as a resumable 3-step workflow (syllabus -> mastery -> deterministic roadmap).
- Memory: profile (durable, encrypted, bound to user id), conversation state (structural, no free text), messages (encrypted; 180-day inactivity retention), `DELETE /agent/memory` forgets everything. All owner-only; educators never read companion data.
- Nudges: deterministic rules (`nudges.ts`), max 2/day, 3-day cooldown per kind, none while active today except plan updates; dedupe keys make jobs idempotent. Graded assessments re-plan only plans approved through the companion.
- Not yet: web search (needs a provider-neutral search capability in the gateway), server-side TTS (browser speechSynthesis is used).

## Learning Studio (`tutor-agent/src/studio/`, web `/studio`)
- A book = pages of structured BLOCKS (never HTML), streamed as NDJSON from `studio_section` and validated per line (`toBlock`): length caps, plain maths (`plainMath`), no markdown; "source" label only with citations retrieved for THAT request + vocabulary overlap, otherwise "ai". Student material first: the uploaded document's own pages (`documents.page`), then retrieval (that document ranked first). Reuses the existing upload/parse/index pipeline; no second ingestion.
- Quick checks are FORMATIVE: never learner evidence. Keys are never trusted: numeric keys need `answerExpr` confirmed by the maths service; MCQ keys are verified (`verifyMcqKey`: numeric options vs evaluated expr, text options vs explanation) or the check is dropped (live runs produced wrong keys). Keys/hints/explanations stay server-side until answered; a missed check makes one FSRS card (`source_ref studio:<book>:<block>`).
- Figures: Wikimedia Commons only, reusable licences only (PD/CC0/CC BY/CC BY-SA), relevance gate on title/description/categories, caption = the image's real title, attribution always shown; no figure rather than a wrong one. Tests use `setImageSearch`.
- Reading state (`session.ts`, server-side): lecture = last completed block; opening another page/asking/highlighting starts a detour with `returnTo`; resume returns exactly there; only forward progress on the lecture page moves the lecture. Page-open prompts are deterministic, built from that page's content.
- Notebook = versioned (author ai|student), derived deterministically from blocks (definitions, formulae, examples, tips, exam points, practice, summary) + asked doubts; student "My notes" never overwritten; stale edits → 409.
- OCR task is category `vision` (a vision-only task in `tutoring` would make every non-vision tutoring route invalid). Needs a vision-capable route; none on the current Groq account.

## Strategic learning & growth (`tutor-agent/src/growth/`, `domain/{exam,strategy,growth,package}.ts`)
- Self-tests (diagnostic / practice / pattern_practice / mock / post) are student-owned rows in `assessments` (`owner_user_id`, `purpose`) on the SAME engine (assembly, marking, evidence rules). RLS: other students never see them; course educators can (they settle written marks); educator lists exclude them.
- Exam intelligence counts questions extracted from papers that were ADDED (student-private or educator-shared; no web scraping): verified frequency (`verified`, named papers) is kept apart from the estimated `priority`; textbook exercises are not exam frequency; never "will appear". Question text encrypted.
- Hint ladder: 6 rungs, one at a time; levels 1-5 from the model with a leak check (`leaks`), level 6 = stored answer + explanation, only after rung 5 or a wrong attempt. `hint_usage` is server truth for `attempts.hints_used` (max with the client value; reset per attempt).
- Strategy/observation are deterministic (`chooseStrategy`, `observe`, `adapt`): findings carry evidence, n and confidence; low-confidence findings never change plans; no psychological labels.
- Growth rewards validated learning only (unaided correct, transfer, beating your own best, mastery, revision, milestones); streaks allow 2 rest days/week; leaderboard is opt-in, pseudonymous, improvement points only, hidden below 5 (`improvement_board()`); cohort outcomes only for consenting students, min group 5 (`cohort_outcomes()`). Outcomes always carry n and a "not causal" caveat.
- Planning: exam goals add "Checking past and sample papers" and "Preparing a short starting-point check" steps (optional: skipped, never failing the plan); paper evidence raises topic weights; roadmap gets a day-1 diagnostic and a final full mock. The orchestrator persists the profile BEFORE tools run.
- Ollama embeddings use a bounded context (`EMBED_CONTEXT` 2048): without it the model loads its full window (470 MB buffers, OOM on this 8 GB machine).

## Rules
- Boundaries enforced by `tooling/check-boundaries.ts`; modules only use `ModuleDeps` from `@platform/contracts`.
- Tutor content is encrypted at rest (`deps.crypto`). Answers/answer specs never sent to students.
- "course" source labels must cite chunks retrieved for that request and pass `groundSegments`; otherwise relabelled "uncertain".
- No mock data in product paths; mocks only in tests (`@platform/testing`).
- Do not commit/push without the user's permission.
