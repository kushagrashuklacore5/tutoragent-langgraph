/**
 * Runs inside a worker thread with resource limits (see parse.ts). Converts a document into
 * locator-addressed text units: PDF pages, PPTX slides, DOCX/text sections. Untrusted input:
 * pdf.js runs without font loading, system fonts or XFA.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { listZipEntries, readZipEntry } from './zip.ts'

type Kind = 'pdf' | 'docx' | 'pptx' | 'text'
interface Out { locatorKind: 'page' | 'slide' | 'section'; pages: string[] }

const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, '&')
const norm = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()

async function pdf(buf: Uint8Array, maxPages: number): Promise<Out> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdf.js v5 has no eval-based font path (the isEvalSupported option was removed with it); fonts are not loaded at all here
  const doc = await pdfjs.getDocument({ data: buf, disableFontFace: true, useSystemFonts: false, enableXfa: false, stopAtErrors: false, verbosity: 0 }).promise
  if (doc.numPages > maxPages) throw new Error(`document has ${doc.numPages} pages (max ${maxPages})`)
  const pages: string[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const tc = await page.getTextContent()
    let text = ''
    let lastY: number | null = null
    for (const item of tc.items as { str?: string; transform?: number[]; hasEOL?: boolean }[]) {
      if (typeof item.str !== 'string') continue
      const y = item.transform?.[5] ?? null
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n'
      text += item.str
      if (item.hasEOL) text += '\n'
      lastY = y
    }
    pages.push(norm(text))
    page.cleanup()
  }
  await doc.destroy()
  return { locatorKind: 'page', pages }
}

function docx(buf: Buffer): Out {
  const entries = listZipEntries(buf)
  const main = entries.find((e) => e.name === 'word/document.xml')
  if (!main) throw new Error('docx without document.xml')
  const xml = readZipEntry(buf, main).toString('utf8')
  // sections split at explicit page breaks; DOCX has no fixed pagination, so locators are "sections"
  const sections: string[] = []
  let cur = ''
  for (const para of xml.split(/<\/w:p>/)) {
    const breakBefore = /<w:br [^>]*w:type="page"/.test(para) || /<w:lastRenderedPageBreak\/>/.test(para)
    const text = [...para.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] === undefined ? '\t' : decodeXml(m[1]))).join('')
    if (breakBefore && cur.trim()) {
      sections.push(norm(cur))
      cur = ''
    }
    if (text.trim()) cur += text + '\n'
  }
  if (cur.trim()) sections.push(norm(cur))
  return { locatorKind: 'section', pages: sections.length ? sections : [''] }
}

function pptx(buf: Buffer): Out {
  const entries = listZipEntries(buf)
  const slides = entries
    .map((e) => ({ e, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(e.name)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)
  return {
    locatorKind: 'slide',
    pages: slides.map(({ e }) => {
      const xml = readZipEntry(buf, e).toString('utf8')
      return norm(xml.split(/<\/a:p>/).map((p) => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => decodeXml(m[1]!)).join('')).filter(Boolean).join('\n'))
    }),
  }
}

function text(buf: Buffer): Out {
  // sections of ~60 lines, never splitting a line
  const lines = buf.toString('utf8').replace(/\r\n/g, '\n').split('\n')
  const pages: string[] = []
  for (let i = 0; i < lines.length; i += 60) pages.push(norm(lines.slice(i, i + 60).join('\n')))
  return { locatorKind: 'section', pages: pages.length ? pages : [''] }
}

type Job = { kind: Kind; data: Uint8Array; maxPages: number }
async function parseJob({ kind, data, maxPages }: Job) {
  try {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const out = kind === 'pdf' ? await pdf(new Uint8Array(buf), maxPages) : kind === 'docx' ? docx(buf) : kind === 'pptx' ? pptx(buf) : text(buf)
    if (out.pages.length > maxPages) throw new Error(`document has ${out.pages.length} pages (max ${maxPages})`)
    return { ok: true, ...out }
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 300) }
  }
}

if (parentPort) {
  // worker-thread mode (kept for compatibility)
  parentPort.postMessage(await parseJob(workerData as Job))
} else if (process.send) {
  // child-process mode (default): one document per process, so pdf.js memory is always returned to the OS
  process.once('message', async (job: Job) => {
    const res = await parseJob(job)
    process.send!(res, () => process.exit(0))
  })
}
