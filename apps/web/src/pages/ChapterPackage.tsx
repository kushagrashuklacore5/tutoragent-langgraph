import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { api, isEndpointMissing } from '../lib/api.ts'
import { S } from '../lib/studio.ts'
import { Button, Card, ErrorNote, Loading, PageHeader, useAction } from '../ui/kit.tsx'

interface Pkg {
  title: string; generatedAt: string
  notes: { topic: string; definitions: { term: string; text: string }[]; keyIdeas: string[] }[]
  formulaSheet: { topic: string; formula: string }[]
  diagrams: { caption: string; thumb?: string; credit?: string; pageUrl?: string }[]
  memoryTricks: string[]; solvedExamples: string[]
  commonMistakes: { text: string; source: string }[]
  pastQuestions: { text: string; marks: number | null; source: string; topic: string | null }[]
  practice: string[]; flashcards: { front: string; back: string }[]; summary: string[]
  lastDaySheet: { mustKnow: string[]; formulae: string[]; weakTopics: string[]; examTips: string[] }
  mastery: { topic: string; level: string; pMastery: number }[]
  mockTestId: string | null
}

/** The chapter learning package: built from what was taught and what you found hard. */
export default function ChapterPackage() {
  const { bookId = '' } = useParams()
  const [pkg, setPkg] = useState<{ version: number; package: Pkg } | null>(null)
  const [missing, setMissing] = useState(false)
  const load = useAction()
  const build = useAction()
  useEffect(() => { void load.run(() => api.get<{ version: number; package: Pkg }>(`${S}/books/${bookId}/package`)).then((r) => { if (r) setPkg(r) }).catch(() => {}) }, [bookId])
  useEffect(() => { if (load.error && (isEndpointMissing(load.error) || (load.error as { status?: number }).status === 404)) setMissing(true) }, [load.error])
  const make = async () => { const r = await build.run(() => api.post<{ version: number; package: Pkg }>(`${S}/books/${bookId}/package`)); if (r) { setPkg(r); setMissing(false) } }

  if (!pkg) {
    if (load.busy) return <Loading label="Opening your package" />
    return (
      <div className="mx-auto grid max-w-xl gap-4">
        <PageHeader title="Chapter package" />
        <Card className="grid gap-3">
          <p>{missing ? 'No package yet for this chapter.' : ''} Your package gathers the notes, formula sheet, diagrams, memory tricks, solved examples, your common mistakes, past questions with sources, flashcards, a last-day sheet, a mock test and your mastery report.</p>
          {build.error ? <ErrorNote error={build.error} /> : null}
          <Button variant="primary" busy={build.busy} onClick={() => void make()}>Build my chapter package</Button>
          <Link to={`/studio/${bookId}`} className="text-sm text-accent underline">Back to the book</Link>
        </Card>
      </div>
    )
  }
  const p = pkg.package
  const sec = (title: string, body: React.ReactNode, show = true) => (show ? <Card className="break-inside-avoid"><h2 className="mb-2 font-serif text-xl">{title}</h2>{body}</Card> : null)
  const list = (xs: string[]) => <ul className="list-disc pl-5 text-sm">{xs.map((x, i) => <li key={i}>{x}</li>)}</ul>
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={p.title} eyebrow={`Chapter package · v${pkg.version} · ${p.generatedAt.slice(0, 10)}`}>
        <div className="flex gap-2 print:hidden">
          <Button onClick={() => window.print()}>Print / save PDF</Button>
          <Button busy={build.busy} onClick={() => void make()}>Rebuild</Button>
          <Link to={`/studio/${bookId}`} className="inline-flex min-h-11 items-center text-sm text-accent underline">Back to the book</Link>
        </div>
      </PageHeader>
      {sec('Last-day revision sheet', <div className="grid gap-3 sm:grid-cols-2 text-sm">
        <div><p className="font-semibold">Must know</p>{list(p.lastDaySheet.mustKnow)}</div>
        <div><p className="font-semibold">Formulae</p>{list(p.lastDaySheet.formulae)}</div>
        <div><p className="font-semibold">Focus (your weaker topics)</p>{p.lastDaySheet.weakTopics.length ? list(p.lastDaySheet.weakTopics) : <p className="text-muted">None below 60% — keep revising.</p>}</div>
        <div><p className="font-semibold">Exam tips</p>{list(p.lastDaySheet.examTips)}</div>
      </div>)}
      {sec('Mastery report', <ul className="grid gap-1 text-sm">{p.mastery.map((m) => <li key={m.topic} className="flex justify-between"><span>{m.topic}</span><span>{m.level} ({Math.round(m.pMastery * 100)}%)</span></li>)}</ul>)}
      {sec('Notes', <div className="grid gap-3">{p.notes.map((n) => <div key={n.topic}><p className="font-semibold">{n.topic}</p><dl className="text-sm">{n.definitions.map((d) => <div key={d.term}><dt className="inline font-semibold">{d.term}: </dt><dd className="inline">{d.text}</dd></div>)}</dl>{list(n.keyIdeas)}</div>)}</div>)}
      {sec('Formula sheet', <table className="w-full text-sm"><tbody>{p.formulaSheet.map((f, i) => <tr key={i} className="border-b border-line"><td className="py-1 pr-3 text-muted">{f.topic}</td><td className="py-1 font-mono">{f.formula}</td></tr>)}</tbody></table>, p.formulaSheet.length > 0)}
      {sec('Diagrams', <div className="grid gap-3 sm:grid-cols-2">{p.diagrams.map((d, i) => <figure key={i}><img src={d.thumb} alt={d.caption} loading="lazy" className="max-h-56 rounded bg-white" /><figcaption className="text-xs">{d.caption}<span className="block text-muted">{d.credit} {d.pageUrl ? <a href={d.pageUrl} target="_blank" rel="noreferrer noopener" className="underline">source</a> : null}</span></figcaption></figure>)}</div>, p.diagrams.length > 0)}
      {sec('Memory tricks', list(p.memoryTricks), p.memoryTricks.length > 0)}
      {sec('Solved examples', list(p.solvedExamples), p.solvedExamples.length > 0)}
      {sec('Common mistakes (yours first)', <ul className="list-disc pl-5 text-sm">{p.commonMistakes.map((m, i) => <li key={i}>{m.text} <span className="text-xs text-muted">— {m.source}</span></li>)}</ul>, p.commonMistakes.length > 0)}
      {sec('Past questions', p.pastQuestions.length ? <ol className="list-decimal pl-5 text-sm">{p.pastQuestions.map((q, i) => <li key={i}>{q.text} <span className="text-xs text-muted">— {q.source}{q.marks !== null ? `, ${q.marks} marks` : ''}</span></li>)}</ol> : <p className="text-sm text-muted">No past papers added for this course yet. Add them in Exam insights; nothing here is invented.</p>)}
      {sec('Practice', list(p.practice), p.practice.length > 0)}
      {sec(`Flashcards (${p.flashcards.length}, added to your revision)`, <ul className="grid gap-2 sm:grid-cols-2 text-sm">{p.flashcards.slice(0, 20).map((f, i) => <li key={i} className="rounded-lg border border-line p-2"><p className="font-semibold">{f.front}</p><p className="text-muted">{f.back}</p></li>)}</ul>)}
      {sec('Mock test', p.mockTestId ? <p className="text-sm">A timed mock test from your educator's approved questions is ready in <b>Assessments</b>.</p> : <p className="text-sm text-muted">No approved questions for this chapter yet, so no mock test could be made.</p>)}
      {sec('Summary', list(p.summary), p.summary.length > 0)}
    </div>
  )
}
