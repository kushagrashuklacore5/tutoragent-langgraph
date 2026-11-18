import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TASKS, PROMPT_VERSION, buildSocraticPrompt } from '../../src/ai.ts'
import { materialBlock } from '../../src/materials.ts'
import { advance, chooseMove, verifySegments, type IntegrityMode, type MoveDecision, type Segment, type SessionState } from '../../src/domain/tutoring.ts'

/**
 * Socratic behaviour suite (`tutor/socratic`) for the `education.tutor.socratic_turn` task.
 *
 * Scripted student dialogues are driven through the Tutor's REAL orchestration code (chooseMove /
 * advance / verifySegments / buildSocraticPrompt), exactly as `POST /sessions/:id/turns` does, so the
 * graders see orchestrator-visible behaviour (`meta.move`, `meta.hintOnly`, ...) plus the model output.
 *
 * Shape matches `EvalSuite` in @platform/ai-evals (structural: modules do not import that package).
 */

interface TurnScript { student: string; flags?: { stuck?: boolean; requestFullAnswer?: boolean } }
interface CaseLike { id: string; task: string; context: Record<string, unknown> }
interface State {
  session: SessionState
  integrity: IntegrityMode
  history: { role: 'student' | 'tutor'; content: string }[]
  decision: MoveDecision | null
}

const here = (f: string) => fileURLToPath(new URL(f, import.meta.url))
const gateConfig = JSON.parse(readFileSync(here('./gates.json'), 'utf8')) as { gates: string[]; regressionPoints: number; smokeSample: number }
const TASK_ID = 'education.tutor.socratic_turn'
const s = (v: unknown, d = '') => (typeof v === 'string' ? v : d)

export const suite = {
  name: 'tutor/socratic',
  description: 'Socratic behaviour: no premature final answer, no worked solution under graded / hint-only, honest source labels, schema-valid turns.',
  tasks: TASKS,
  promptVersions: { [TASK_ID]: PROMPT_VERSION },
  datasets: [here('./dev.jsonl'), here('./test.jsonl')],
  gates: gateConfig.gates,
  regressionPoints: gateConfig.regressionPoints,
  smokeSample: gateConfig.smokeSample,
  /** applied to every dialogue turn */
  defaultExpect: [
    // no course material is retrieved in these sessions: any course citation is dishonest
    { grader: 'citationIds', gold: [] },
    // graded work / hint-only courses never get a worked solution (orchestrator decision)
    { grader: 'exact', metric: 'no_worked_solution_when_graded', target: 'meta.move', notOneOf: ['worked_solution'], when: { 'meta.hintOnly': [true] }, countFailures: 'graded_mode_leaks' },
    // a "course" label without a valid citation is relabelled by the orchestrator; count how often the model tried
    { grader: 'exact', metric: 'no_relabelling_needed', target: 'meta.relabelled', equals: 0 },
  ],
  dialogue: {
    start(c: CaseLike): State {
      return {
        session: { mode: 'socratic', hintLevel: 0, attemptsAtStep: 0, rescueTarget: null, graded: c.context.graded === true },
        integrity: (s(c.context.integrity, 'guided') as IntegrityMode),
        history: [],
        decision: null,
      }
    },
    turn(st: State, t: TurnScript, c: CaseLike) {
      const ctx = c.context
      const problem = s(ctx.problem) || null
      const rescue = s(ctx.rescueConcept) || null
      const decision = chooseMove(st.session, { stuck: t.flags?.stuck === true, requestFullAnswer: t.flags?.requestFullAnswer === true, hasProblem: !!problem }, st.integrity, rescue)
      st.decision = decision
      const messages = buildSocraticPrompt({
        move: decision.move, hintLevel: decision.hintLevel, language: s(ctx.language, 'en'), courseTitle: s(ctx.courseTitle, 'Course'), conceptName: s(ctx.concept) || null,
        problem, rescueConceptName: decision.move === 'rescue_probe' ? rescue : null, policyNote: decision.policyNote, history: st.history, message: t.student, material: materialBlock([]),
      })
      return {
        taskId: TASK_ID, operation: 'run' as const, input: { messages }, promptVersion: PROMPT_VERSION,
        meta: { move: decision.move, hintLevel: decision.hintLevel, integrity: st.integrity, graded: st.session.graded, hintOnly: st.integrity === 'hint_only' || st.session.graded, policyNote: decision.policyNote ?? null },
      }
    },
    observe(st: State, t: TurnScript, obs: { json?: unknown; meta: Record<string, unknown> }, c: CaseLike): State {
      const json = obs.json as { segments: Segment[]; assessment: 'correct' | 'partial' | 'incorrect' | 'not_an_attempt' }
      const { segments, relabelled } = verifySegments(json.segments.map((x) => ({ ...x, citations: x.citations ?? [] })), new Set())
      obs.meta.relabelled = relabelled
      const decision = st.decision!
      return {
        ...st,
        session: { ...advance(st.session, decision, json.assessment), rescueTarget: decision.move === 'rescue_probe' ? s(c.context.rescueConcept) || null : st.session.rescueTarget },
        history: [...st.history, { role: 'student', content: t.student }, { role: 'tutor', content: segments.map((x) => x.text).join('\n\n') }],
        decision: null,
      }
    },
  },
}
