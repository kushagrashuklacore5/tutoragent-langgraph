/** Teaching choreography: pure rules from the MEANING of a real lesson block to action, gaze and board cues. */

/** the controller's explicit states (one loop drives the character from these; nothing else animates her) */
export type CharacterState = 'idle' | 'hover' | 'greeting' | 'listening' | 'thinking' | 'speaking' | 'explaining' | 'pointing' | 'emphasizing' | 'happy' | 'encouraging' | 'confused' | 'celebrating' | 'asking_question' | 'summarising' | 'interrupted' | 'goodbye'
export type Action = 'welcome_and_wave' | 'audience_explanation' | 'turn_towards_board' | 'point_to_board' | 'trace_equation' | 'explain_with_open_palms' | 'emphasize_important_point' | 'compare_with_both_hands' | 'ask_student_question' | 'attentive_listening' | 'thoughtful_pause' | 'encouraging_response' | 'celebrate_correct_answer' | 'supportive_wrong_answer' | 'conclude_lesson' | 'count_on_fingers'
export type Gaze = 'audience' | 'board' | 'away'

/** Higher wins. A hover never interrupts teaching; the student's voice always can. */
const PRIORITY: Record<CharacterState, number> = { idle: 0, hover: 1, goodbye: 2, greeting: 3, thinking: 4, confused: 4, speaking: 5, explaining: 5, pointing: 5, emphasizing: 5, asking_question: 5, summarising: 5, happy: 6, encouraging: 6, celebrating: 6, listening: 7, interrupted: 8 }
/** Raise Hand (interrupted) beats everything; after it only listening, thinking or idle may follow */
export const canEnter = (from: CharacterState, to: CharacterState) => to === 'idle' || to === 'listening' || to === 'interrupted' || (from === 'interrupted' ? to === 'thinking' : PRIORITY[to] >= PRIORITY[from] || from === 'hover' || from === 'greeting' || from === 'goodbye')

export const STATE_ACTION: Record<CharacterState, Action> = {
  idle: 'audience_explanation', hover: 'welcome_and_wave', greeting: 'welcome_and_wave', listening: 'attentive_listening', thinking: 'thoughtful_pause', speaking: 'audience_explanation',
  explaining: 'explain_with_open_palms', pointing: 'point_to_board', emphasizing: 'emphasize_important_point', happy: 'celebrate_correct_answer', encouraging: 'encouraging_response', confused: 'supportive_wrong_answer',
  celebrating: 'celebrate_correct_answer', asking_question: 'ask_student_question', summarising: 'conclude_lesson', interrupted: 'attentive_listening', goodbye: 'conclude_lesson',
}

export const stateFor = (a: Action): CharacterState => {
  switch (a) {
    case 'welcome_and_wave': return 'greeting'
    case 'emphasize_important_point': return 'emphasizing'
    case 'ask_student_question': return 'asking_question'
    case 'attentive_listening': return 'listening'
    case 'thoughtful_pause': return 'thinking'
    case 'encouraging_response': return 'encouraging'
    case 'celebrate_correct_answer': return 'celebrating'
    case 'supportive_wrong_answer': return 'encouraging'
    case 'conclude_lesson': return 'summarising'
    case 'audience_explanation': return 'speaking'
    case 'point_to_board': case 'trace_equation': case 'turn_towards_board': return 'pointing'
    default: return 'explaining'
  }
}

export interface Phase { from: number; to: number; action: Action; gaze: Gaze; highlight: boolean; /** step number for counting gestures (1, 2, 3 …) */ count?: number }
export interface SegmentInput { type: string; speech: string; index: number; total: number; /** the real text of the board block this segment teaches */ board?: string }

const STRESS = /\b(important|remember|key|must|never|always|note|exam|mistake)\b|ध्यान|याद|ज़रूरी|जरूरी|गलती|महत्वपूर्ण/i
const CONTRAST = /\b(versus|vs|difference|compare|whereas|while|unlike|but)\b|जबकि|अंतर|फ़र्क|फर्क|लेकिन/i
const ON_BOARD = new Set(['definition', 'formula', 'example', 'figure', 'excerpt', 'list'])

/** the main teaching action of a segment, decided by block type first, then by what the sentence says */
export function actionFor(s: SegmentInput): Action {
  if (s.type === 'question') return 'ask_student_question'
  if (s.type === 'feedback_correct') return 'celebrate_correct_answer'
  if (s.type === 'feedback_support') return 'supportive_wrong_answer'
  if (s.type === 'summary') return 'conclude_lesson'
  if (s.type === 'formula') return 'trace_equation'
  if (s.type === 'exam' || s.type === 'tip') return 'emphasize_important_point'
  // the greeting belongs to the greeting state only (when she meets the student), never to a lesson sentence
  if (s.type === 'heading') return 'audience_explanation'
  if (s.type === 'figure' || s.type === 'definition' || s.type === 'excerpt') return 'point_to_board'
  if (CONTRAST.test(s.speech)) return 'compare_with_both_hands'
  if (s.type === 'example' || s.type === 'list') return 'point_to_board'
  if (STRESS.test(s.speech)) return 'emphasize_important_point'
  // controlled variation: alternates by position, so a replay looks identical and repeats never look robotic
  return s.index % 2 ? 'explain_with_open_palms' : 'audience_explanation'
}

const COMMON = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'from', 'have', 'has', 'you', 'your', 'can', 'will', 'not', 'but', 'its', 'our', 'they', 'then', 'into', 'also', 'which', 'when', 'what', 'how', 'see', 'look', 'here', 'now', 'let', 'very', 'like', 'more', 'one', 'two'])
const words = (x: string) => [...x.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]{3,}/gu)].filter((m) => !COMMON.has(m[0]))
/** Where in the sentence she first names something that is really on the board (0..1), or null if she never does. */
export function firstReference(speech: string, board: string): number | null {
  const on = new Set(words(board).map((m) => m[0]))
  const hit = words(speech).find((m) => on.has(m[0]))
  return hit ? hit.index / Math.max(1, speech.length) : null
}

/**
 * Timeline of one segment as fractions of its spoken length. Board content is introduced facing the student, Vidya turns
 * and points while the highlight is on, then turns back to finish to the student.
 */
export function phasesFor(s: SegmentInput): Phase[] {
  const a = actionFor(s)
  if (a === 'point_to_board' || a === 'trace_equation' || (ON_BOARD.has(s.type) && a === 'compare_with_both_hands')) {
    const main = a === 'compare_with_both_hands' ? 'point_to_board' : a
    const ref = s.board === undefined ? null : firstReference(s.speech, s.board)
    // words that never touch what is on the board give no reason to turn (a formula or figure IS the subject)
    if (s.board !== undefined && ref === null && s.type !== 'formula' && s.type !== 'figure') return [{ from: 0, to: 1, action: a === 'compare_with_both_hands' ? a : 'explain_with_open_palms', gaze: 'audience', highlight: false }]
    const at = ref === null ? 0.14 : Math.max(0.08, Math.min(0.5, ref - 0.06))
    const hold = Math.min(0.86, at + 0.54)
    return [
      { from: 0, to: at, action: 'audience_explanation', gaze: 'audience', highlight: false },
      { from: at, to: at + 0.1, action: 'turn_towards_board', gaze: 'board', highlight: true },
      { from: at + 0.1, to: hold, action: main, gaze: 'board', highlight: true },
      // steps of a worked example or list are then presented on her fingers
      { from: hold, to: 1, action: a === 'compare_with_both_hands' ? a : s.type === 'list' || s.type === 'example' ? 'count_on_fingers' : 'explain_with_open_palms', gaze: 'audience', highlight: false },
    ]
  }
  return sentenceBeats(s, a)
}

export const phaseAt = (ps: Phase[], f: number) => ps.find((p) => f >= p.from && f < p.to) ?? ps[ps.length - 1]!

/** Share of the lesson's spoken time looking at the student (tuning target about 70%, but content decides). */
export function audienceShare(segs: SegmentInput[]) {
  let audience = 0, total = 0
  for (const s of segs) {
    const w = Math.max(1, s.speech.length)
    total += w
    for (const p of phasesFor(s)) if (p.gaze === 'audience') audience += (p.to - p.from) * w
  }
  return total ? audience / total : 1
}

/** Real parts of a formula for term-by-term highlighting: split at operators, never invented. */
export function formulaTerms(text: string): string[] {
  const main = text.split(/\s{2,}\(|\s\(\w+:/)[0]!.trim()
  return main.split(/(\s*[=+\-−×÷*/]\s*)/).filter((x) => x.trim() && !/^\s*[=+\-−×÷*/]\s*$/.test(x)).map((x) => x.trim()).slice(0, 8)
}
/** Real steps of a worked example: its own sentences and arrows. */
export function exampleSteps(text: string): string[] {
  const parts = text.split(/(?<=[.!?।:])\s+|\s*(?:→|=>)\s*|\n+/).map((x) => x.trim()).filter(Boolean)
  return parts.length ? parts.slice(0, 8) : [text]
}
/** Which step is being explained at a spoken fraction of the segment. */
export const stepAt = (n: number, f: number) => (n <= 0 ? -1 : Math.min(n - 1, Math.floor(Math.max(0, f) * n)))

/* ── gestures sentence by sentence, from what she actually says ───────────────────────────────────────────────── */
const ORDINALS: [RegExp, number][] = [
  [/\b(first|firstly|step\s*1|one)\b|पहल[ाीे]|प्रथम|pehla|pehle/i, 1],
  [/\b(second|secondly|step\s*2|two|next|then)\b|दूसर[ाीे]|फिर|उसके बाद|doosra|dusra|phir/i, 2],
  [/\b(third|thirdly|step\s*3|three|finally|lastly|last)\b|तीसर[ाीे]|आख़िर|आखिर|अंत में|teesra|tisra|aakhir/i, 3],
]
const QUESTION = /\?\s*$|\b(can you|do you|what do you think|why do you think|guess)\b|बताओ|बताइए|क्या आप|kya aap|batao/i
const ENCOURAGE = /\b(great|well done|good job|excellent|don'?t worry|you can|easy|nice|perfect|exactly|keep going)\b|शाबाश|बढ़िया|बहुत अच्छा|चिंता मत|आसान|shabaash|badhiya|bahut accha|chinta mat|aasaan/i
const SUM_UP = /\b(so,|in short|to sum up|to summari[sz]e|in summary|overall|that'?s why|remember this)\b|संक्षेप में|तो कुल मिलाकर|यानी|sankshep|kul milakar/i
const INTRO = /\b(today|let'?s (learn|start|begin|talk)|we will learn|welcome)\b|आज हम|चलिए|आइए|aaj hum|chaliye|aaiye/i

/** sentences of the speech with their share of its length (0..1) */
export function sentencesOf(speech: string): { text: string; from: number; to: number }[] {
  const parts = speech.split(/(?<=[.!?।])\s+/).map((x) => x.trim()).filter(Boolean)
  const total = parts.reduce((n, x) => n + x.length, 0) || 1
  let at = 0
  return parts.map((text) => { const from = at / total; at += text.length; return { text, from, to: at / total } })
}

/** what ONE sentence does in teaching terms (never random: the same sentence always gets the same gesture) */
export function sentenceAction(text: string, s: SegmentInput, i: number): { action: Action; count?: number } {
  if (s.type === 'summary' || SUM_UP.test(text)) return { action: 'conclude_lesson' }
  if (QUESTION.test(text)) return { action: 'ask_student_question' }
  const step = ORDINALS.find(([re]) => re.test(text))
  if (step && (s.type === 'list' || s.type === 'example' || /\b(step|first|second|third|finally)\b|पहल|दूसर|तीसर/i.test(text))) return { action: 'count_on_fingers', count: step[1] }
  if (CONTRAST.test(text)) return { action: 'compare_with_both_hands' }
  if (STRESS.test(text)) return { action: 'emphasize_important_point' }
  if (ENCOURAGE.test(text)) return { action: 'encouraging_response' }
  if (INTRO.test(text)) return { action: 'audience_explanation' }
  // plain explanation: open-palm and audience gestures alternate by sentence, so a long explanation never loops one move
  return { action: (s.index + i) % 2 ? 'explain_with_open_palms' : 'audience_explanation' }
}

/** a segment that is not about board content: one gesture per sentence, merged when neighbours mean the same */
export function sentenceBeats(s: SegmentInput, blockAction: Action): Phase[] {
  // block types that ARE the gesture (a question, feedback, the closing summary) keep it for the whole segment
  if (['ask_student_question', 'celebrate_correct_answer', 'supportive_wrong_answer'].includes(blockAction)) return [{ from: 0, to: 1, action: blockAction, gaze: 'audience', highlight: false }]
  const out: Phase[] = []
  sentencesOf(s.speech).forEach((x, i) => {
    let { action, count } = sentenceAction(x.text, s, i)
    if (blockAction === 'emphasize_important_point' && action !== 'count_on_fingers' && action !== 'ask_student_question') action = 'emphasize_important_point'
    const last = out.at(-1)
    if (last && last.action === action && last.count === count) last.to = x.to
    else out.push({ from: x.from, to: x.to, action, gaze: 'audience', highlight: false, ...(count ? { count } : {}) })
  })
  return out.length ? out : [{ from: 0, to: 1, action: blockAction, gaze: 'audience', highlight: false }]
}
