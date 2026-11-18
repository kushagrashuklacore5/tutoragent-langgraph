/**
 * Openly licensed images for book figures, from Wikimedia Commons (MediaWiki API) only.
 * - Only licences that allow reuse with attribution are accepted (public domain, CC0, CC BY, CC BY-SA).
 * - Attribution (author, licence, link to the file page) is stored with the figure and always displayed.
 * - Fixed host, short timeout, generic user agent (no student data is sent: the query is a topic phrase).
 * - Fail closed: no image rather than an unlicensed or unverifiable one. At most one figure per section.
 */
export interface ImageHit { url: string; thumb: string; width: number; height: number; title: string; pageUrl: string; license: string; licenseUrl: string; credit: string; /** title + description + categories, for the relevance gate */ about?: string }
export type ImageSearch = (query: string, signal?: AbortSignal) => Promise<ImageHit[]>

const ALLOWED = [/^public domain$/i, /^pd/i, /^cc0/i, /^cc[- ]by(-sa)?([- ][\d.]+)?$/i, /^cc[- ]by(-sa)?[- ][\d.]+[- ]?\w*$/i]
const MIMES = new Set(['image/png', 'image/jpeg', 'image/svg+xml', 'image/gif'])
const stripHtml = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()
export const licenceAllowed = (name: string) => ALLOWED.some((r) => r.test(name.trim()))

/** Parse a Commons `generator=search&prop=imageinfo` response; keep only reusable, displayable images. */
export function parseCommons(json: unknown): ImageHit[] {
  const pages = (json as { query?: { pages?: Record<string, unknown> } })?.query?.pages
  if (!pages) return []
  const out: (ImageHit & { index: number })[] = []
  for (const p of Object.values(pages) as { title?: string; index?: number; imageinfo?: { url?: string; thumburl?: string; thumbwidth?: number; thumbheight?: number; descriptionurl?: string; mime?: string; extmetadata?: Record<string, { value?: string }> }[] }[]) {
    const ii = p.imageinfo?.[0]
    if (!ii?.url || !ii.descriptionurl || !MIMES.has(ii.mime ?? '')) continue
    const m = ii.extmetadata ?? {}
    const license = stripHtml(m.LicenseShortName?.value ?? '')
    if (!license || !licenceAllowed(license)) continue
    if (/^https:\/\/(upload|commons)\.wikimedia\.org\//.test(ii.url) === false) continue
    const artist = stripHtml(m.Artist?.value ?? '') || 'Unknown author'
    out.push({
      url: ii.url, thumb: ii.thumburl ?? ii.url, width: ii.thumbwidth ?? 0, height: ii.thumbheight ?? 0,
      title: stripHtml(m.ObjectName?.value ?? p.title?.replace(/^File:/, '') ?? ''), pageUrl: ii.descriptionurl,
      license, licenseUrl: stripHtml(m.LicenseUrl?.value ?? ''), credit: `${artist.slice(0, 120)} · ${license} · Wikimedia Commons`, index: p.index ?? 99,
      about: [p.title ?? '', stripHtml(m.ObjectName?.value ?? ''), stripHtml(m.ImageDescription?.value ?? '').slice(0, 600), stripHtml(m.Categories?.value ?? '').replace(/\|/g, ' ')].join(' '),
    })
  }
  return out.sort((a, b) => a.index - b.index).map(({ index: _i, ...h }) => h)
}

const GENERIC = new Set(['diagram', 'diagrams', 'graph', 'figure', 'image', 'picture', 'illustration', 'chart', 'of', 'the', 'a', 'an', 'and', 'in', 'on', 'for', 'with', 'to'])
const words = (s: string) => s.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1)
/**
 * Relevance gate: search engines happily return unrelated images. A hit is kept only if its title, description
 * or categories contain most of the query's content words (at least one, and at least half).
 */
export function relevance(query: string, hit: Pick<ImageHit, 'title' | 'about'>): number {
  const want = [...new Set(words(query).filter((w) => !GENERIC.has(w)))].map((w) => w.replace(/s$/, ''))
  if (!want.length) return 0
  const inTitle = new Set(words(hit.title).map((w) => w.replace(/s$/, '')))
  const have = new Set(words(`${hit.title} ${hit.about ?? ''}`).map((w) => w.replace(/s$/, '')))
  const found = want.filter((w) => have.has(w)).length
  // short queries need every content word; longer ones three quarters
  if (found < (want.length <= 3 ? want.length : Math.ceil(want.length * 0.75))) return 0
  return found + want.filter((w) => inTitle.has(w)).length
}
export const relevant = (query: string, hit: Pick<ImageHit, 'title' | 'about'>) => relevance(query, hit) > 0

export const commonsSearch: ImageSearch = async (query, signal) => {
  const q = `${query.replace(/[^\p{L}\p{N} '\-]/gu, ' ').slice(0, 80)} diagram`
  const url = `https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=${encodeURIComponent(`${q} filetype:bitmap|drawing`)}&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=640&origin=*`
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 5000)
  signal?.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'EkBharatLearningStudio/0.1 (educational platform; figure lookup)' } })
    if (!r.ok) return []
    return parseCommons(await r.json()).map((h) => ({ h, s: relevance(query, h) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.h)
  } catch {
    return []
  } finally {
    clearTimeout(t)
  }
}

let current: ImageSearch = commonsSearch
/** Test seam: replace the image source (tests must not depend on the network). */
export const setImageSearch = (fn: ImageSearch | null) => { current = fn ?? commonsSearch }
export const searchImages: ImageSearch = (q, s) => current(q, s)
