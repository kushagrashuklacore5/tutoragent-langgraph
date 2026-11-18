/**
 * Page-bounded chunking: chunks never cross a page/slide/section, so every citation points at exactly
 * one source location, with character offsets into that page's stored text.
 */
export interface Chunk {
  page: number
  charStart: number
  charEnd: number
  text: string
  ordinal: number
}

export interface ChunkOptions {
  targetChars?: number
  maxChars?: number
  overlapChars?: number
  minChars?: number
}

export function chunkPages(pages: string[], o: ChunkOptions = {}): Chunk[] {
  const target = o.targetChars ?? 1400
  const max = o.maxChars ?? 2200
  const overlap = o.overlapChars ?? 200
  const min = o.minChars ?? 40
  const out: Chunk[] = []
  pages.forEach((pageText, i) => {
    const page = i + 1
    if (!pageText.trim()) return
    // paragraph boundaries (with offsets), then hard-split oversize paragraphs at sentence/space boundaries
    const units: { start: number; end: number }[] = []
    const re = /[^\n]+(\n|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(pageText))) {
      if (!m[0].length) break
      let s = m.index
      const e = m.index + m[0].length
      while (e - s > max) {
        let cut = pageText.lastIndexOf('. ', s + max)
        if (cut <= s + target / 2) cut = pageText.lastIndexOf(' ', s + max)
        if (cut <= s) cut = s + max
        units.push({ start: s, end: cut + 1 })
        s = cut + 1
      }
      units.push({ start: s, end: e })
    }
    let cs = -1
    let ce = -1
    const flush = () => {
      if (cs < 0) return
      const text = pageText.slice(cs, ce).trim()
      if (text.length >= min || (!out.some((c) => c.page === page) && text.length)) out.push({ page, charStart: cs, charEnd: ce, text, ordinal: out.length })
      cs = -1
    }
    for (const u of units) {
      if (cs < 0) {
        cs = u.start
        ce = u.end
        continue
      }
      if (u.end - cs > target) {
        const prevEnd = ce
        flush()
        // overlap: restart a little before the previous end, on a word boundary
        const back = Math.max(0, prevEnd - overlap)
        const ws = pageText.indexOf(' ', back)
        cs = ws >= 0 && ws < u.start ? ws + 1 : u.start
      }
      ce = u.end
    }
    flush()
  })
  return out
}

export function normalize(v: number[]): number[] {
  let s = 0
  for (const x of v) s += x * x
  const n = Math.sqrt(s)
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n)
}
