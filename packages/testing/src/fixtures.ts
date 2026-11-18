import { crc32, deflateRawSync } from 'node:zlib'

/** Build a real, multi-page PDF (standard Helvetica) whose page N contains exactly `pages[N-1]` lines. */
export function makePdf(pages: string[][]): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objs: string[] = []
  const pageIds: number[] = []
  // 1: catalog, 2: pages, 3: font, then per page: page obj + content obj
  let next = 4
  const pageObjs: string[] = []
  for (const lines of pages) {
    const pid = next++
    const cid = next++
    pageIds.push(pid)
    const stream = `BT /F1 12 Tf 72 740 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
    pageObjs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`
    pageObjs[cid] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
  }
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let i = 4; i < next; i++) objs[i] = pageObjs[i]!
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 1; i < next; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1')
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${next}\n0000000000 65535 f \n` + offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Minimal ZIP writer (deflate) for DOCX/PPTX fixtures. */
export function makeZip(files: Record<string, string | Buffer>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
    const comp = deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42)
    locals.push(lh, nameBuf, comp)
    centrals.push(ch, nameBuf)
    offset += 30 + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** DOCX whose sections are separated by explicit page breaks. */
export function makeDocx(sections: string[][]): Buffer {
  const body = sections.map((paras, i) =>
    paras.map((p, j) => `<w:p>${i > 0 && j === 0 ? '<w:r><w:br w:type="page"/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xmlEsc(p)}</w:t></w:r></w:p>`).join('')).join('')
  return makeZip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  })
}

export function makePptx(slides: string[][]): Buffer {
  const files: Record<string, string> = { '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' }
  slides.forEach((paras, i) => {
    files[`ppt/slides/slide${i + 1}.xml`] = `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paras.map((p) => `<a:p><a:r><a:t>${xmlEsc(p)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
  })
  return makeZip(files)
}

/** Bag-of-words hashing embedder: deterministic, gives meaningful lexical-semantic similarity for tests. */
export function hashingEmbed(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0)
  for (const w of text.toLowerCase().match(/[a-zऀ-ॿ0-9]+/g) ?? []) {
    if (w.length < 3) continue
    let h = 2166136261
    for (const ch of w.slice(0, 6)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) // crude stemming: first 6 letters
    v[(h >>> 0) % dims]! += 1
  }
  return v
}
