import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { newId } from '@platform/core'
import { enqueue } from '@platform/jobs'
import { setupTestDb, makePdf, makeDocx, makePptx, makeZip, type PlatformTestDb } from '@platform/testing'
import { createDocumentService, documentsMigrations, localObjectStore, parseDocument, sniff, validateUpload, devNoopScanner, type Scanner } from '@platform/documents'

let t: PlatformTestDb
let dir: string
const A = newId()
const B = newId()
const alice = newId()
const bob = newId()
const P = (tenantId: string, userId: string) => ({ tenantId, userId, roles: ['student'] })

before(async () => {
  t = await setupTestDb([documentsMigrations])
  dir = await mkdtemp(join(tmpdir(), 'docs-'))
  await t.system.query(`insert into platform.tenants (id, slug, name, type) values ($1, 'da', 'A', 'institution'), ($2, 'db', 'B', 'institution')`, [A, B])
})
after(async () => {
  await t.close()
  await rm(dir, { recursive: true, force: true })
})

const svc = (scanner: Scanner = devNoopScanner) => createDocumentService({ db: t.db, system: t.system, store: localObjectStore(dir, randomBytes(32)), scanner, enqueue: (tx, type, payload, o) => enqueue(tx, type, payload, o) })

describe('validation', () => {
  test('type is sniffed from bytes, not the name; macros and junk rejected', () => {
    assert.equal(sniff(makePdf([['x']])), 'pdf')
    assert.equal(sniff(makeDocx([['x']])), 'docx')
    assert.equal(sniff(makePptx([['x']])), 'pptx')
    assert.equal(sniff(Buffer.from('plain notes\nline 2')), 'text')
    assert.equal(sniff(makeZip({ 'word/document.xml': '<w:document/>', 'word/vbaProject.bin': 'x' })), null)
    assert.equal(sniff(Buffer.from([0, 1, 2, 3, 0])), null)
    assert.throws(() => validateUpload(Buffer.from('MZ\x90\x00 fake exe'), 'notes.pdf'), { code: 'unsupported_file' })
    assert.throws(() => validateUpload(Buffer.alloc(0), 'a.pdf'), { code: 'empty_file' })
    assert.equal(validateUpload(makePdf([['x']]), '../../etc/passwd\u0000.pdf').filename, 'passwd_.pdf')
  })
  test('zip bombs are rejected by ratio/size limits', () => {
    const bomb = makeZip({ 'word/document.xml': 'A'.repeat(20 * 1024 * 1024) })
    assert.equal(sniff(bomb), null)
  })
})

describe('parsing (isolated worker)', () => {
  test('PDF: one entry per page, text on the right page', async () => {
    const p = await parseDocument('pdf', makePdf([['Page one: limits'], ['Page two: derivatives'], ['Page three: integrals']]))
    assert.equal(p.locatorKind, 'page')
    assert.deepEqual(p.pages, ['Page one: limits', 'Page two: derivatives', 'Page three: integrals'])
  })
  test('DOCX sections split at page breaks; PPTX slides; text sections', async () => {
    assert.deepEqual((await parseDocument('docx', makeDocx([['a', 'b'], ['c']]))).pages, ['a\nb', 'c'])
    assert.deepEqual((await parseDocument('pptx', makePptx([['s1'], ['s2']]))).pages, ['s1', 's2'])
    assert.equal((await parseDocument('text', Buffer.from(Array.from({ length: 130 }, (_, i) => `line ${i}`).join('\n')))).pages.length, 3)
  })
  test('malformed PDF fails cleanly; page limit enforced; timeout kills the worker', async () => {
    await assert.rejects(parseDocument('pdf', Buffer.from('%PDF-1.4\n garbage')), { code: 'parse_failed' })
    await assert.rejects(parseDocument('pdf', makePdf([['1'], ['2'], ['3']]), { maxPages: 2 }), /max 2/)
    await assert.rejects(parseDocument('pdf', makePdf(Array.from({ length: 300 }, (_, i) => [`p${i}`])), { timeoutMs: 1 }), { code: 'parse_timeout' })
  })
})

describe('storage', () => {
  test('originals are encrypted at rest and keys cannot escape the store', async () => {
    const store = localObjectStore(dir, randomBytes(32))
    const key = `${A}/education.tutor/${newId()}`
    await store.put(key, Buffer.from('SECRET-NOTES-CONTENT'))
    const files = await readdir(join(dir, A, 'education.tutor'))
    const raw = await readFile(join(dir, A, 'education.tutor', files[0]!))
    assert.ok(!raw.includes(Buffer.from('SECRET-NOTES-CONTENT')))
    assert.equal((await store.get(key)).toString(), 'SECRET-NOTES-CONTENT')
    await assert.rejects(store.put('../../evil', Buffer.from('x')), { code: 'storage_key_invalid' })
    await assert.rejects(store.get(`${A}/education.tutor/../../x`), { code: 'storage_key_invalid' })
  })
})

describe('service', () => {
  test('upload -> process -> pages; private documents visible only to their owner; other tenant sees nothing', async () => {
    const s = svc()
    const doc = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:1', visibility: 'private', trust: 'student_upload', filename: 'my notes.pdf', data: makePdf([['alpha'], ['beta']]) })
    assert.equal(doc.status, 'uploaded')
    assert.equal(await s.process(doc.id, async () => undefined), 'ready')
    assert.equal((await s.page(P(A, alice), doc.id, 2)).text, 'beta')
    await assert.rejects(s.page(P(A, bob), doc.id, 1), { code: 'not_found' })
    await assert.rejects(s.get(P(B, alice), doc.id), { code: 'not_found' })
    const jobs = await t.system.query(`select count(*)::int as n from platform.jobs where type = 'platform.documents/process'`)
    assert.ok((jobs.rows[0] as { n: number }).n >= 1, 'processing job enqueued with the upload')
  })
  test('virus-positive files fail processing; checksum mismatch fails', async () => {
    const infected: Scanner = { id: 'test', async scan() { return { clean: false, signature: 'Eicar-Test-Signature' } } }
    const s = svc(infected)
    const doc = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:1', visibility: 'scope', trust: 'verified_course', filename: 'x.pdf', data: makePdf([['x']]) })
    assert.equal(await s.process(doc.id, async () => undefined), 'failed')
    assert.match((await s.get(P(A, alice), doc.id)).error!, /virus scan \(Eicar/)
  })
  test('only the owner deletes; delete removes row, pages and the stored original', async () => {
    const s = svc()
    const doc = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:2', visibility: 'scope', trust: 'verified_course', filename: 'd.pdf', data: makePdf([['d']]) })
    await s.process(doc.id, async () => undefined)
    await assert.rejects(s.delete(P(A, bob), doc.id), { code: 'forbidden' })
    await s.delete(P(A, alice), doc.id)
    const left = await t.system.query('select (select count(*) from platform.documents where id = $1)::int + (select count(*) from platform.document_pages where document_id = $1)::int as n', [doc.id])
    assert.equal((left.rows[0] as { n: number }).n, 0)
    await assert.rejects(readFile(join(dir, ...doc.storage_key.split('/'))))
  })
  test('new versions supersede the previous one once processed; scope must match', async () => {
    const s = svc()
    const v1 = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:3', visibility: 'scope', trust: 'verified_course', filename: 'v.pdf', data: makePdf([['v1']]) })
    await s.process(v1.id, async () => undefined)
    await assert.rejects(s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:OTHER', visibility: 'scope', trust: 'verified_course', filename: 'v.pdf', data: makePdf([['v2']]), supersedes: v1.id }), { code: 'supersede_mismatch' })
    const v2 = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:3', visibility: 'scope', trust: 'verified_course', filename: 'v.pdf', data: makePdf([['v2']]), supersedes: v1.id })
    assert.equal(v2.version, 2)
    await s.process(v2.id, async () => undefined)
    assert.equal((await s.get(P(A, alice), v1.id)).status, 'superseded')
    assert.deepEqual((await s.list(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:3' })).map((d) => d.version), [2])
  })
  test('reprocess resets status and enqueues a new job', async () => {
    const s = svc()
    const d = await s.upload(P(A, alice), { ownerModule: 'education.tutor', scope: 'course:4', visibility: 'scope', trust: 'verified_course', filename: 'r.pdf', data: makePdf([['r']]) })
    await s.process(d.id, async () => undefined)
    await s.reprocess(P(A, alice), d.id)
    assert.equal((await s.get(P(A, alice), d.id)).status, 'uploaded')
  })
})
