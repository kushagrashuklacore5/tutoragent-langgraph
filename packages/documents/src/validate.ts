import { badRequest } from '@platform/core'
import { listZipEntries } from './zip.ts'

export type DocumentKind = 'pdf' | 'docx' | 'pptx' | 'text'

export const MAX_BYTES = 50 * 1024 * 1024
export const MAX_PAGES = 500

const MIME: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  text: 'text/plain',
}

/**
 * Determine the real type from the bytes (never trust the extension or Content-Type).
 * DOCX/PPTX are zip containers identified by their main part; macro-enabled variants are rejected.
 */
export function sniff(buf: Buffer): DocumentKind | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf'
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    let names: string[]
    try {
      names = listZipEntries(buf).map((e) => e.name)
    } catch {
      return null
    }
    if (names.some((n) => /vbaProject\.bin$/i.test(n))) return null // macros never accepted
    if (names.includes('word/document.xml')) return 'docx'
    if (names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) return 'pptx'
    return null
  }
  // plain text: valid UTF-8 without NUL bytes
  if (buf.includes(0)) return null
  const s = buf.toString('utf8')
  if (Buffer.from(s, 'utf8').equals(buf)) return 'text'
  return null
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'document'
  const clean = base.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^\.+/, '').trim().slice(0, 200)
  return clean || 'document'
}

export function validateUpload(buf: Buffer, filename: string): { kind: DocumentKind; mime: string; filename: string } {
  if (!buf.length) throw badRequest('empty_file', 'The file is empty')
  if (buf.length > MAX_BYTES) throw badRequest('file_too_large', `Files must be at most ${MAX_BYTES / 1024 / 1024} MB`)
  const kind = sniff(buf)
  if (!kind) throw badRequest('unsupported_file', 'Only PDF, Word (.docx), PowerPoint (.pptx) and plain-text files are supported (no macros)')
  // the name must not claim a different type than the bytes (e.g. text renamed to .pdf)
  const ext = /\.([a-z0-9]{1,5})$/i.exec(filename)?.[1]?.toLowerCase()
  const EXT: Record<string, DocumentKind> = { pdf: 'pdf', docx: 'docx', pptx: 'pptx', txt: 'text', md: 'text', text: 'text' }
  if (ext && EXT[ext] && EXT[ext] !== kind) throw badRequest('type_mismatch', `The file content is not a valid .${ext} file`)
  return { kind, mime: MIME[kind], filename: sanitizeFilename(filename) }
}
