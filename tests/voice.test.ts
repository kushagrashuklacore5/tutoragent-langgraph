/** Voice input: speech-to-text through the gateway, content-sniffed audio, enrolment-checked, routed by data policy. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { silentWav } from '@platform/ai-gateway'
import { setupTutorWorld, type TutorWorld } from './tutor-setup.ts'

let w: TutorWorld
const T = '/api/m/education.tutor'
const heard: (string | undefined)[] = []

async function post(token: string, body: Buffer, q = '') {
  const res = await fetch(`${w.h.url}${T}/courses/${w.courseId}/voice/transcribe${q}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'audio/wav' }, body: new Uint8Array(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

before(async () => {
  w = await setupTutorWorld({ transcribe: (a, lang) => (heard.push(lang), `x squared plus two x (${a.length} bytes)`) })
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await w.h.call('POST', '/api/admin/ai/connections', w.admin, { adapter: 'fake', name: 'stt', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  assert.equal((await w.h.call('POST', '/api/admin/ai/models/approve', w.admin, { adapter: 'fake', modelId: 'whisper', declared: { operations: ['transcribe'] } })).status, 204)
  const dep = await w.h.call('POST', '/api/admin/ai/deployments', w.admin, { connectionId: conn.json.id, modelId: 'whisper' })
  const probe = await w.h.call('POST', `/api/admin/ai/deployments/${dep.json.id}/probe`, w.admin)
  assert.ok(probe.json.verified.operations.includes('transcribe'), JSON.stringify(probe.json))
  assert.equal((await w.h.call('PUT', '/api/admin/ai/routes', w.admin, { target: 'category:speech_to_text', candidates: [{ deploymentId: dep.json.id }] })).status, 200)
})
after(() => w.close())

test('an enrolled student gets a transcript; the language hint is passed through', async () => {
  const r = await post(w.stu, silentWav(1), '?language=hi')
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.match(r.json.text, /x squared plus two x \(32044 bytes\)/)
  assert.equal(heard.at(-1), 'hi')
  await post(w.stu, silentWav(1), '?language=fr')
  assert.equal(heard.at(-1), undefined, 'unsupported language hints are dropped (auto-detect)')
})

test('audio is validated by content, and access is enrolment-checked', async () => {
  assert.equal((await post(w.stu, Buffer.from('%PDF-1.7 definitely not audio'.padEnd(200, ' ')))).status, 400)
  assert.equal((await post(w.stu, Buffer.alloc(50))).status, 400)
  assert.equal((await post(w.admin, silentWav(1))).status, 404)
  const ops = await w.owner.query(`select status from platform.ai_operations where task_id = 'education.tutor.transcribe'`)
  assert.equal(ops.rows.length, 2, 'only valid, authorised requests reach the gateway (and are metered)')
})
