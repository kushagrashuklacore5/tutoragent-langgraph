# Tutor evals

Evaluation assets for the Tutor's AI tasks. They run on the shared framework (`packages/ai-evals`). Design:
`docs/EVALUATION_AND_TESTING.md` of the Tutor plan.

> **Status: starter fixtures only.** The datasets here are small, **synthetic** fixtures. They exercise the
> pipeline and the orchestrator's Socratic rules. The pilot datasets (educator-verified Q&A, gold passages,
> 150 scripted simulations per course, and Hindi/Hinglish native-speaker sets) are **pending data from the pilot institutions**.
> Real student data enters only with consent, anonymised, and with tenant approval. Passing these fixtures is
> **not** evidence of model quality, and in particular not when run with the fake adapter.

## `socratic/` (suite `tutor/socratic`, task `education.tutor.socratic_turn`)

| File | Purpose |
|---|---|
| `dev.jsonl` (6) / `test.jsonl` (12) | Scripted student dialogues covering the scenarios correct, partial, wrong, "just tell me" and stuck, in English, Hindi and Hinglish, under open / guided / hint-only / graded modes. Tune on `dev` only. |
| `suite.ts` | Drives each turn through the Tutor's real orchestration (`chooseMove`, `buildSocraticPrompt`, `verifySegments`, `advance`). Graders assert on the decisions (`meta.move`, `meta.hintOnly`) as well as on the model output. |
| `gates.json` | Gates (see below), the regression threshold (2 points) and the smoke sample (10% of `test`). |
| `fake-tutor.ts` | A deterministic scripted "model" for pipeline tests. `scripted-tutor` behaves correctly. `scripted-leaky` reveals answers and must fail. |

Gates: `no_premature_answer >= 0.9`, `graded_mode_leaks == 0`, `not_in_material_honesty >= 0.95`,
`schema_valid_rate >= 0.98`, `error_rate <= 0.02`, `p95_latency_ms <= 6000`.
These gates live here for now. The contracts' `evals` manifest field only lists suites. When the manifest supports
`evals.gates`, move the gates there.

Metrics that are reported but not gated: `orchestrator_move` (the expected teaching move was taken),
`assessment_matches`, `no_worked_solution_when_graded`, `no_relabelling_needed`.

Still to add once validated human labels exist: hint relevance and progression through `rubricJudge`.
A judge must reach at least 0.8 agreement with human labels first.

## Running

```
node tooling/evals.ts run tutor/socratic --route modules/education-agents/tutor-agent/evals/routes/fake.json --split all
node tooling/evals.ts run tutor/socratic --route <real-routing.json> --smoke            # PR smoke
node tooling/evals.ts run tutor/socratic --route <real-routing.json> --baseline <prev>/report.json --record-standing
```

`routes/example.provider.json` shows a real-provider config: keys come from environment variables. `socratic.e2e.test.ts`
runs the CLI end-to-end against a test database with the fake adapter. It shows that a correct tutor passes, that a
leaky one fails both the gates and the regression rule, and that no standing is recorded for fakes.
