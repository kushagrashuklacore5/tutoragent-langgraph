/**
 * Durable lecture / interruption model of a Studio book (pure, unit-tested).
 *   lecture       where teaching stands: the last block the student has completed (page + block id)
 *   view          the page the student has open now
 *   interruption  a detour (opened another page, asked, highlighted, spoke) with the lecture position to return to
 * Rules: detours never move the lecture position; resuming returns to exactly the lecture position (the next block
 * to teach is the one after `lecture.blockId`), so nothing is repeated or skipped. Only advancing on the lecture
 * page (or the page right after it) moves the lecture forward, and only forwards.
 */
export type StudyMode = 'read' | 'listen' | 'read_listen' | 'conversation'
export interface Position { pageNo: number; blockId: string | null }
export interface Interruption { kind: 'page' | 'question' | 'highlight' | 'voice'; pageNo: number; returnTo: Position; startedAt: string; asked: number }
export interface StudioState { mode: StudyMode; lecture: Position; view: Position; interruption: Interruption | null; sectionId: string | null }
export const initialStudio = (): StudioState => ({ mode: 'read', lecture: { pageNo: 1, blockId: null }, view: { pageNo: 1, blockId: null }, interruption: null, sectionId: null })

/** Order of blocks across the book: page number, then position on the page. */
export type BookIndex = Map<number, string[]>
export function blockOrder(index: BookIndex, p: Position): number {
  const ids = index.get(p.pageNo) ?? []
  const i = p.blockId ? ids.indexOf(p.blockId) : -1
  return p.pageNo * 1000 + i
}

/** The student opened a page. A different page than the lecture page starts a 'page' detour (once). */
export function viewPage(s: StudioState, pageNo: number, now: Date): { state: StudioState; detour: boolean } {
  const view = { pageNo, blockId: null }
  if (s.interruption) {
    // already on a detour: back on the lecture page ends a page-detour silently
    if (s.interruption.kind === 'page' && pageNo === s.interruption.returnTo.pageNo) return { state: { ...s, view, interruption: null }, detour: false }
    return { state: { ...s, view, interruption: { ...s.interruption, pageNo } }, detour: false }
  }
  if (pageNo === s.lecture.pageNo || pageNo === s.lecture.pageNo + 1) return { state: { ...s, view }, detour: false }
  return { state: { ...s, view, interruption: { kind: 'page', pageNo, returnTo: { ...s.lecture }, startedAt: now.toISOString(), asked: 0 } }, detour: true }
}

/** A question (typed, spoken or about a highlight) starts or continues a detour; the return point never changes. */
export function ask(s: StudioState, kind: 'question' | 'highlight' | 'voice', pageNo: number, now: Date): StudioState {
  if (s.interruption) return { ...s, interruption: { ...s.interruption, kind: s.interruption.kind === 'page' ? kind : s.interruption.kind, pageNo, asked: s.interruption.asked + 1 } }
  return { ...s, interruption: { kind, pageNo, returnTo: { ...s.lecture }, startedAt: now.toISOString(), asked: 1 } }
}

/** Return to the lecture: the view jumps back to the exact lecture position. */
export function resume(s: StudioState): { state: StudioState; position: Position } {
  const position = s.interruption ? { ...s.interruption.returnTo } : { ...s.lecture }
  return { state: { ...s, interruption: null, view: { ...position } }, position }
}

/** The student completed a block. Moves the lecture forward only (and not while on a detour elsewhere). */
export function advance(s: StudioState, to: Position, index: BookIndex): StudioState {
  if (s.interruption && to.pageNo !== s.interruption.returnTo.pageNo) return s
  if (blockOrder(index, to) <= blockOrder(index, s.lecture)) return s
  return { ...s, lecture: { ...to }, view: { ...to }, interruption: s.interruption && to.pageNo === s.interruption.returnTo.pageNo ? null : s.interruption }
}

/** The next block to teach after the lecture position (null = end of generated content). */
export function nextBlock(index: BookIndex, lecture: Position): Position | null {
  const pages = [...index.keys()].sort((a, b) => a - b)
  const ids = index.get(lecture.pageNo) ?? []
  const i = lecture.blockId ? ids.indexOf(lecture.blockId) : -1
  if (i + 1 < ids.length) return { pageNo: lecture.pageNo, blockId: ids[i + 1]! }
  const nextPage = pages.find((p) => p > lecture.pageNo && (index.get(p) ?? []).length)
  return nextPage === undefined ? null : { pageNo: nextPage, blockId: index.get(nextPage)![0]! }
}

const T = {
  en: (p: number, h: string, first: string, back: number) => `You're on page ${p}${h ? ` — "${h}"` : ''}${first ? `: ${first}` : ''}. Any doubt about this page? When you're ready, we'll go back to page ${back}.`,
  hinglish: (p: number, h: string, first: string, back: number) => `Aap page ${p} par ho${h ? ` — "${h}"` : ''}${first ? `: ${first}` : ''}. Is page par koi doubt hai? Jab ready ho, page ${back} par wapas chalenge.`,
  hi: (p: number, h: string, first: string, back: number) => `आप पेज ${p} पर हैं${h ? ` — "${h}"` : ''}${first ? `: ${first}` : ''}। इस पेज पर कोई सवाल है? तैयार हों तो पेज ${back} पर लौटेंगे।`,
}
/** Deterministic prompt about the page the student opened (built from the page's actual content). */
export function pagePrompt(lang: 'en' | 'hi' | 'hinglish', pageNo: number, heading: string, firstSentence: string, backTo: number): string {
  const s = firstSentence.trim().replace(/[.!?।]+$/, '')
  const first = s.length > 140 ? `${s.slice(0, 139)}…` : s
  return T[lang](pageNo, heading, first, backTo)
}
