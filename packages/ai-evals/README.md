# @platform/ai-evals

Reusable AI evaluation framework (F9). Spec: [AI_EVALUATION_FRAMEWORK.md](../../docs/platform-planning/AI_EVALUATION_FRAMEWORK.md);
standings: [AI_GATEWAY.md § 8](../../docs/platform-planning/AI_GATEWAY.md). Any module can use it; the Tutor is the first user
(`modules/education-agents/tutor-agent/evals/`).

## Pieces

| File | What it does |
|---|---|
| `dataset.ts` | Versioned JSONL cases (`id, task, input, context, expect, tags, split, source`). Strict validation: any bad line rejects the whole file, with line numbers. `dev.jsonl` / `test.jsonl` may only hold that split. The version is a sha256 of the canonical (key-sorted) cases. `selectCases` filters by split/tags and takes a deterministic hash sample (the PR smoke suite). |
| `graders.ts` | Composable graders: `exact`, `regex`, `jsonSchema` (ajv), `numericTolerance`, `solverEquivalent` (injected `MathChecker`; `unverified` always fails), `citationIds` (precision/recall vs gold ids; with empty gold, any citation fails `not_in_material_honesty`), `latencyBudget`, `costBudget`, `entailmentJudge`, `rubricJudge`. Specs take `target` (path such as `json.segments[*].citations`, `meta.move`), `metric`, `when` (only apply to matching observations) and `countFailures` (also count failures into a count metric such as `graded_mode_leaks`). A grader that throws, or a call that failed, produces a failure. A broken grader can never make a case pass. |
| `judges.ts` | Judges are gateway tasks (`platform.evals.entailment_judge`, `platform.evals.rubric_judge`: pinned, no fallback). `validateJudge` measures agreement (and κ) with human labels. `trustJudge` refuses a judge whose validation is missing, belongs to another version, or falls below 0.8 (or has fewer than 20 items). The runner refuses to start a suite that uses an untrusted judge, before it spends anything. |
| `runner.ts` | `runSuite` runs cases through a real `Gateway` (`run` / `stream` / `embed`). It enforces a concurrency limit, a spend cap (needs metering; it stops starting new cases, and an incomplete run fails), a per-case timeout, and records per-case failures. Dialogue cases (`input.turns`) go through the suite's `DialogueDriver`, which is the module's real orchestration code. Graders see `meta.*` (orchestrator-visible decisions). A rate passes for a dialogue only if every applicable turn passes. Each call runs in its own trace, so its metered attempts (`ai_operations`) give cost and tokens. The run also writes a reproducibility record: dataset hash, case-selection hash, prompt versions, task definitions and hashes, routes actually used, route-config hash (keys redacted), judge versions and agreement, git commit, node version. |
| `report.ts` | JSON report plus Markdown summary. Rates come with a Wilson 95% CI and means with a normal-approximation CI. Also covered: p50/p95 latency and first-token time, cost and tokens, a breakdown per tag and per task, and a diff against a baseline. |
| `gates.ts` | `metric op threshold` expressions (`>= <= > < == !=`). An unmeasured metric fails. **Regression rule:** a gated metric that gets more than 2 points worse than the baseline fails, even above the gate. Points are percentage points for 0..1 metrics and percent change otherwise. The direction comes from the gate operator. |
| `standings.ts` | `recordStandings` writes `ai_eval_standings` through `gateway.admin.recordEvalStanding` only when the report passed: all gates, the regression rule, and a complete run. It writes only for a deployment that served every call of the task without fallback, and never for `fake*` adapters. A failing run writes nothing. |
| `outcomes.ts` | Offline learning-outcome analysis, not CI gates: Hake normalized gain, delayed retention, transfer performance against near items, calibration (Brier score, ECE, reliability bins, over-confidence). |

Built-in run metrics: `case_pass_rate`, `error_rate`, `schema_valid_rate`, `p50_latency_ms`, `p95_latency_ms`,
`p50_first_token_ms`, `p95_first_token_ms` (streamed calls), `cost_micros_total`, `cost_micros_per_case`.

## Writing a suite

Put the suite in `modules/<vertical>/<agent>/evals/<suite>/suite.ts`, exporting `suite` with the `EvalSuite` shape. The type check is
structural, so modules do not import this package. Fields: `name`, `tasks`, `promptVersions`, `datasets` (absolute paths),
`gates`, optional `defaultExpect`, `buildCall`, `dialogue`, `regressionPoints`, `smokeSample`. Keep tuning on `dev`.
Never tune on `test`.

## CLI

```
node tooling/evals.ts list
node tooling/evals.ts run <suite> --route <routing-config.json> [--baseline report.json] [--split test|dev|all] [--smoke]
                     [--sample 0.25] [--tags hi,graded] [--concurrency 4] [--spend-cap-micros N] [--case-timeout-ms N]
                     [--tenant <uuid>] [--out dir] [--record-standing]
node tooling/evals.ts validate-judge <rubric|entailment> --labels labels.jsonl --route <routing-config.json> [--out v.json]
```

It needs `SYSTEM_DATABASE_URL` (or `DATABASE_URL`) pointing at a migrated platform DB, and `PLATFORM_MASTER_KEY`. Routes are
written for the config's eval environment only, and `production` is refused. Eval traffic is metered to the
`platform-evals` tenant. Reports go to `.data/evals/<suite>/<runId>/report.{json,md}`. Exit codes: 0 means the gates
passed, 1 means they failed, 2 means a usage or setup error. The routing-config format is documented at the top of
`tooling/evals.ts`; examples are in `modules/education-agents/tutor-agent/evals/routes/`.

## Not yet built

- An `eval_runs` table (reports are files for now). A `humanReview` grader that queues to a review UI.
- Wiring `MathChecker` to `@platform/math-client`. The integrator passes `{ equivalent }` to `runSuite({ math })`.
