/**
 * Chapter learning package (pure): assembled from what was ACTUALLY taught (the book's blocks and notebook) and
 * what the student actually struggled with (missed checks, diagnoses, low mastery). No model call; every item
 * keeps where it came from.
 */
export interface PkgBlock { id: string; type: string; text: string; term?: string; items?: string[]; label: string; cites: { filename: string; page: number }[]; figure?: { caption: string; thumb?: string; credit?: string; pageUrl?: string } }
export interface PkgTopic { title: string; definitions: { term: string; text: string }[]; formulae: string[]; examples: string[]; memoryTricks: string[]; examPoints: string[]; doubts: { q: string; a: string }[]; practice: string[]; summary: string; myNotes: string }
export interface Pyq { text: string; marks: number | null; source: string; topic: string | null }
export interface ChapterPackage {
  title: string; generatedAt: string
  notes: { topic: string; definitions: { term: string; text: string }[]; keyIdeas: string[] }[]
  formulaSheet: { topic: string; formula: string }[]
  diagrams: { caption: string; thumb?: string; credit?: string; pageUrl?: string }[]
  memoryTricks: string[]
  solvedExamples: string[]
  commonMistakes: { text: string; source: string }[]
  pastQuestions: Pyq[]
  practice: string[]
  flashcards: { front: string; back: string }[]
  summary: string[]
  lastDaySheet: { mustKnow: string[]; formulae: string[]; weakTopics: string[]; examTips: string[] }
  mastery: { topic: string; level: string; pMastery: number }[]
  mockTestId: string | null
}

const uniq = (xs: string[]) => [...new Map(xs.filter(Boolean).map((x) => [x.toLowerCase(), x])).values()]

export function assemblePackage(o: {
  title: string; now: Date; topics: PkgTopic[]; blocks: PkgBlock[]
  missedChecks: { prompt: string; explanation: string }[]; diagnoses: { misconception: string; concept: string }[]
  pastQuestions: Pyq[]; mastery: { topic: string; level: string; pMastery: number }[]; mockTestId: string | null
}): ChapterPackage {
  const t = o.topics
  const flashcards = [
    ...t.flatMap((x) => x.definitions.map((d) => ({ front: `Define: ${d.term}`, back: d.text }))),
    ...t.flatMap((x) => x.formulae.map((f) => ({ front: `Formula (${x.title}): ${f.split(/[=(:]/)[0]!.trim() || f}`, back: f }))),
    ...o.missedChecks.map((m) => ({ front: m.prompt, back: m.explanation || 'Re-read the section and try again.' })),
  ].slice(0, 60)
  const weak = o.mastery.filter((m) => m.pMastery < 0.6).sort((a, b) => a.pMastery - b.pMastery).map((m) => m.topic)
  return {
    title: o.title, generatedAt: o.now.toISOString(),
    notes: t.map((x) => ({ topic: x.title, definitions: x.definitions, keyIdeas: uniq([...x.examPoints.slice(0, 2), x.summary].filter(Boolean)) })),
    formulaSheet: t.flatMap((x) => uniq(x.formulae).map((formula) => ({ topic: x.title, formula }))),
    diagrams: o.blocks.filter((b) => b.type === 'figure' && b.figure?.thumb).map((b) => b.figure!),
    memoryTricks: uniq(t.flatMap((x) => x.memoryTricks)),
    solvedExamples: uniq(t.flatMap((x) => x.examples)).slice(0, 12),
    commonMistakes: [
      ...o.diagnoses.map((d) => ({ text: `${d.concept}: ${d.misconception}`, source: 'your own answers (diagnosed)' })),
      ...o.missedChecks.map((m) => ({ text: m.prompt, source: 'a quick check you missed' })),
      ...uniq(t.flatMap((x) => x.examPoints.filter((e) => /mistake|wrong|forget|confus/i.test(e)))).map((text) => ({ text, source: 'chapter exam points' })),
    ].slice(0, 15),
    pastQuestions: o.pastQuestions.slice(0, 25),
    practice: uniq(t.flatMap((x) => x.practice)).slice(0, 20),
    flashcards,
    summary: t.map((x) => x.summary).filter(Boolean),
    lastDaySheet: {
      mustKnow: uniq(t.flatMap((x) => x.definitions.map((d) => `${d.term}: ${d.text}`))).slice(0, 12),
      formulae: uniq(t.flatMap((x) => x.formulae)).slice(0, 15),
      weakTopics: weak.slice(0, 6),
      examTips: uniq(t.flatMap((x) => x.examPoints)).slice(0, 8),
    },
    mastery: o.mastery,
    mockTestId: o.mockTestId,
  }
}
