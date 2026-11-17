# AI Evaluation Framework (`packages/ai-evals`)

Updated 2026-11-16 · **[Proposed]** · PD-14 · Reusable by every module; the Tutor is its first user.

## 1. What it evaluates
| Dimension | Example metric | Grader type |
|---|---|---|
| Answer quality | correctness rate, rubric score | deterministic where possible, else validated model judge |
| Citation accuracy | citation precision/recall, "not in source" honesty | deterministic (chunk ids) + entailment judge |
| Tutoring effectiveness | no-premature-answer rate, hint relevance, progression, misconception refutation | scripted simulated-student dialogues + rubric judge; human audit sample |
| Learning outcomes (offline) | pre/post gain, delayed retention, transfer | imported study results (not a CI gate) |
| Structured output | schema-valid first try / after retry | deterministic |
| Safety & injection | policy compliance, injected-instruction resistance | deterministic + judge |
| Latency | p50/p95 first token and total | measured |
| Cost | INR per case, per simulated session | from gateway metering |

## 2. Building blocks
- **Dataset** — versioned JSONL in the module's `evals/` folder. Case fields: `id`, `task`, `input`,
  `context` (e.g. document fixture ids, learner snapshot), `expect` (assertions), `tags`
  (language, difficulty, topic), `split` (`dev` | `test`), `source` (educator, synthetic, consented).
- **Graders** (composable): `exact`, `regex`, `jsonSchema`, `numericTolerance`, `solverEquivalent`
  (via math-solver), `citationIds`, `entailmentJudge`, `rubricJudge`, `dialogueSimulator`,
  `latencyBudget`, `costBudget`, `humanReview` (queues to a review UI).
- **Judges** are gateway tasks with **pinned routes**; each judge has its own validation set and is
  only trusted when agreement with human labels ≥ 0.8 (recorded per judge version).
- **Runner** — `evals run <module> --suite <name> --route <routing-config>`: executes cases
  through the real gateway (or fake adapter for framework tests), with concurrency limits and a
  spend cap.
- **Report** — per-metric results, confidence intervals, per-tag breakdown, diffs vs baseline,
  cost and latency; stored as artifacts and in an `eval_runs` table (no student data).
- **Gates** — declared in the module manifest (`evals.gates`), e.g.
  `citation_precision >= 0.95`, `numeric_wrong_keys == 0`, `p95_first_token_ms <= 6000`.

## 3. When it runs
| Trigger | Suite |
|---|---|
| Pull request touching prompts, task definitions, retrieval, or the module | smoke (≈ 10% of test split, gates enforced) |
| Routing/model change (config) | full test split for affected tasks on the new route — change blocked until gates pass |
| Nightly | full suites, all routes in use |
| New provider adapter | conformance suite + full suites on that adapter before any routing to it |

## 4. Reproducibility and integrity
- Every run records: dataset version hash, prompt versions, task definitions, route (provider,
  model, parameters), judge versions, code commit.
- `test` split is never used for prompt tuning; tuning uses `dev`.
- Regression rule: any gated metric dropping > 2 points vs baseline fails, even if above the gate.
- Real student data enters datasets only with consent, anonymised, and with tenant approval.

## 5. Cross-provider comparison
The same suite runs against every deployment a route might use (any adapter: OpenAI, Anthropic,
Gemini, Groq, Ollama, OpenAI-compatible, and future ones). Reports show quality, latency and cost
side by side. A passing run writes an `ai_eval_standings` row, which the gateway requires before a
deployment can be routed, or used as a fallback, for that task in production
([AI_GATEWAY.md](AI_GATEWAY.md) § 8).
