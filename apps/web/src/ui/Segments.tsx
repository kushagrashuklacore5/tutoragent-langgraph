import { SOURCE_META, citationLabel, type Citation, type Segment, type SourceType } from '../lib/tutor.ts'
import { Icon, type IconName } from './icons.tsx'
import { Markdown } from './Markdown.tsx'

const SOURCE_STYLE: Record<SourceType, { cls: string; icon: IconName }> = {
  course: { cls: 'bg-src-course-bg text-src-course border-src-course/40', icon: 'book' },
  general: { cls: 'bg-src-general-bg text-src-general border-line-strong', icon: 'globe' },
  ai_example: { cls: 'bg-src-example-bg text-src-example border-src-example-line border-dashed', icon: 'beaker' },
  uncertain: { cls: 'bg-src-uncertain-bg text-src-uncertain border-src-uncertain/40', icon: 'question' },
}

export function SourceChip({ source }: { source: SourceType }) {
  const s = SOURCE_STYLE[source]
  const m = SOURCE_META[source]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[0.78rem] font-semibold ${s.cls}`} title={m.description}>
      <Icon name={s.icon} size={14} />
      <span>{m.label}</span>
      <span className="sr-only">: {m.description}</span>
    </span>
  )
}

export function CitationPill({ c, onOpen }: { c: Citation; onOpen: (c: Citation) => void }) {
  return (
    <button type="button" onClick={() => onOpen(c)}
      className="anim inline-flex min-h-8 items-center gap-1 rounded-md border border-src-course/40 bg-surface px-2 font-mono text-[0.78rem] text-src-course hover:bg-src-course-bg"
      aria-label={`Open source: ${c.filename}, page ${c.pageStart}${c.pageEnd > c.pageStart ? ` to ${c.pageEnd}` : ''}`}>
      [{citationLabel(c)}]
    </button>
  )
}

/** Answer segments, each with its source label first and citation pills after. */
export function SegmentList({ segments, onOpenCitation }: { segments: Segment[]; onOpenCitation: (c: Citation) => void }) {
  return (
    <div className="space-y-3">
      {segments.map((s, i) => (
        <div key={i} className={`border-l-2 pl-3 ${s.source === 'course' ? 'border-src-course' : s.source === 'uncertain' ? 'border-src-uncertain' : s.source === 'ai_example' ? 'border-src-example-line border-dashed' : 'border-line-strong'}`}>
          <div className="mb-1 flex flex-wrap items-center gap-2"><SourceChip source={s.source} />{s.math === 'verified' ? <span className="inline-flex items-center gap-1 rounded-md bg-ok-bg px-1.5 py-0.5 text-[0.74rem] font-semibold text-ok" title="The calculations in this part were checked by a maths engine"><Icon name="check" size={12} />Maths checked</span> : s.math === 'failed' ? <span className="inline-flex items-center gap-1 rounded-md bg-warn-bg px-1.5 py-0.5 text-[0.74rem] font-semibold text-warn"><Icon name="alert" size={12} />A calculation here did not check out</span> : null}</div>
          <Markdown text={s.text} />
          {s.citations.length ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Sources">{s.citations.map((c, j) => <CitationPill key={j} c={c} onOpen={onOpenCitation} />)}</div>
          ) : null}
        </div>
      ))}
    </div>
  )
}
