import { readFileSync } from 'node:fs'

/**
 * Deterministic scripted "tutor model" for PIPELINE tests of the Socratic suite (fake adapter only).
 * It reads the teaching move the orchestrator put in the system prompt and answers in the
 * socratic_turn JSON shape. Its scores say nothing about any real model's quality.
 *
 *  - model `scripted-tutor`: follows the move (never reveals the answer outside worked_solution)
 *  - model `scripted-leaky`: appends the final answer to every reply (must FAIL the gates)
 */

interface Msg { role: string; content: unknown }
interface Req { messages: Msg[] }
interface Result {
  text: string
  toolCalls: never[]
  finish: 'stop'
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: null; reasoningTokens: null }
}

// problem → gold answer, from the suite's own fixtures
const ANSWERS = new Map<string, string>()
for (const f of ['dev.jsonl', 'test.jsonl']) {
  for (const line of readFileSync(new URL(`./${f}`, import.meta.url), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const c = JSON.parse(line) as { context: { problem?: string; answer?: string } }
    if (c.context.problem && c.context.answer) ANSWERS.set(c.context.problem.trim(), c.context.answer)
  }
}

const text = (m: Msg | undefined) => (typeof m?.content === 'string' ? m.content : '')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
export function answerPattern(answer: string): RegExp {
  const m = /^([a-z])\s*=\s*(.+)$/.exec(answer)
  // not followed by another digit, a fraction slash or a decimal part ("5." ending a sentence still counts)
  return m ? new RegExp(`\\b${m[1]}\\s*=\\s*${esc(m[2]!)}(?![\\d/]|\\.\\d)`) : new RegExp(`(?<![\\d./])${esc(answer)}(?![\\d/]|\\.\\d)`)
}

function assess(student: string, answer: string | undefined): string {
  if (answer && answerPattern(answer).test(student)) return 'correct'
  if (!/\d/.test(student)) return 'not_an_attempt'
  return /not sure|i think|lcm|\bbut\b/i.test(student) ? 'partial' : 'incorrect'
}

const REPLIES: Record<string, (hint: number, answer: string) => string> = {
  ask: () => 'Before we solve it, what do you already know here? What would your first step be?',
  hint: (h) => h <= 1 ? 'Hint: look at what is being done to the unknown, and think about how to undo it.' : h === 2 ? 'Hint: use inverse operations - undo the addition or subtraction first, then the multiplication.' : 'Hint: do the first undo step on both sides and tell me what you get.',
  explain: () => 'Here is the idea: whatever you do to one side of an equation, do to the other side. Can you try one step?',
  worked_solution: (_h, a) => `Step by step: undo each operation on both sides in reverse order. That gives the final answer ${a}. Now try a similar problem on your own.`,
  rescue_probe: () => 'Quick check on a building block: what operation undoes adding 4?',
  check: () => 'Can you explain in one sentence why that step works?',
}

export function respond(req: Req, model: string): Result {
  const system = req.messages.find((m) => m.role === 'system' && text(m).includes('TEACHING MOVE:'))
  const sys = text(system)
  const move = /TEACHING MOVE: ([a-z_]+)/.exec(sys)?.[1] ?? 'ask'
  const hint = Number(/level-(\d)/.exec(sys)?.[1] ?? 1)
  const problem = /<<<\n([\s\S]*?)\n>>>/.exec(sys)?.[1]?.trim() ?? ''
  const answer = ANSWERS.get(problem) ?? ''
  const student = text([...req.messages].reverse().find((m) => m.role === 'user'))
  let reply = (REPLIES[move] ?? REPLIES.ask!)(hint, answer)
  if (model === 'scripted-leaky' && move !== 'worked_solution') reply += ` (The answer is ${answer}.)`
  const out = JSON.stringify({ segments: [{ text: reply, source: 'general', citations: [] }], assessment: assess(student, answer), checkQuestion: 'What would you do next?' })
  const inputTokens = Math.ceil(req.messages.reduce((a, m) => a + text(m).length, 0) / 4)
  return { text: out, toolCalls: [], finish: 'stop', usage: { inputTokens, outputTokens: Math.ceil(out.length / 4), cachedInputTokens: null, reasoningTokens: null } }
}
