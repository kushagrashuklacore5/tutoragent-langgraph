/**
 * Shared setup for the tutor workstream-D tests (streaming, encryption at rest, recurring jobs):
 * one institution with the tutor enabled, a second one without it, an educator, two students, a course
 * with two approved concepts (Functions → Limits), numeric items, and an AI route to the fake model.
 */
import assert from 'node:assert/strict'
import pg from 'pg'
import { manifest as tutor } from '@modules/education-tutor-agent'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import type { FakeBehaviour } from '@platform/ai-gateway/testing'
import type { MathChecker } from '@platform/contracts'
import { startHarness, type Harness } from './helpers.ts'

export interface TutorWorld {
  h: Harness
  admin: string; prof: string; stu: string; stu2: string
  courseId: string; cFunctions: string; cLimits: string
  /** owner connection (bypasses RLS) for assertions on what is physically stored */
  owner: pg.Client
  close(): Promise<void>
}

export async function setupTutorWorld(fake: FakeBehaviour, opts: { math?: MathChecker; documents?: boolean } = {}): Promise<TutorWorld> {
  const h = await startHarness([tutor], { fake, math: opts.math, documents: opts.documents })
  await h.app.identity.createTenant({ slug: 'iit-x', name: 'X', adminEmail: 'admin@x.test' })
  await h.app.identity.createTenant({ slug: 'nit-y', name: 'Y', adminEmail: 'admin@y.test' })
  const sys = createSystemDatabase(h.test.systemUrl)
  await sys.query(`update platform.tenants set enabled_modules = '{education.tutor}' where slug = 'iit-x'`)
  await sys.query(`update platform.users set is_platform_admin = true where email = 'admin@x.test'`)
  await sys.close()
  const admin = await h.signIn('iit-x', 'admin@x.test')
  for (const [email, roles] of [['prof@x.test', ['educator']], ['stu@x.test', ['student']], ['stu2@x.test', ['student']]] as const) {
    assert.equal((await h.call('POST', '/api/members', admin, { email, roles })).status, 200)
  }
  const prof = await h.signIn('iit-x', 'prof@x.test')
  const stu = await h.signIn('iit-x', 'stu@x.test')
  const stu2 = await h.signIn('iit-x', 'stu2@x.test')
  const policy = { processingLocation: 'IN', selfHosted: true, retentionDays: 0, zeroRetention: true, trainsOnData: false, dpaInPlace: true, termsVerified: true }
  const conn = await h.call('POST', '/api/admin/ai/connections', admin, { adapter: 'fake', name: 'tutor-model', baseUrl: 'http://127.0.0.1:9', allowPrivateNetwork: true, dataPolicy: policy })
  await h.call('POST', '/api/admin/ai/models/approve', admin, { adapter: 'fake', modelId: 'tutor-1', declared: { operations: ['generate', 'stream'], structuredOutput: 'json_mode', contextWindow: 32000 } })
  const dep = await h.call('POST', '/api/admin/ai/deployments', admin, { connectionId: conn.json.id, modelId: 'tutor-1' })
  assert.equal((await h.call('PUT', '/api/admin/ai/routes', admin, { target: 'category:tutoring', candidates: [{ deploymentId: dep.json.id }] })).status, 200)

  const courseId = (await h.call('POST', '/api/m/education.tutor/courses', prof, { code: 'MA101', title: 'Calculus I', integrityMode: 'guided' })).json.id
  const cFunctions = (await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts`, prof, { name: 'Functions', estMinutes: 40 })).json.id
  const cLimits = (await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts`, prof, { name: 'Limits', estMinutes: 60, examWeight: 3, prerequisites: [cFunctions] })).json.id
  for (const id of [cFunctions, cLimits]) assert.equal((await h.call('POST', `/api/m/education.tutor/courses/${courseId}/concepts/${id}/approve`, prof)).status, 204)
  const members = (await h.call('GET', '/api/members', admin)).json as { user_id: string; email: string }[]
  for (const email of ['stu@x.test', 'stu2@x.test']) {
    const r = await h.call('POST', `/api/m/education.tutor/courses/${courseId}/enrolments`, prof, { userId: members.find((x) => x.email === email)!.user_id, role: 'student' })
    assert.equal(r.status, 204)
  }
  await h.call('POST', `/api/m/education.tutor/courses/${courseId}/items`, prof, { conceptId: cLimits, stem: 'lim x->2 of (x+40)?', answerSpec: { type: 'numeric', value: 42, tolerance: 0 }, explanation: 'Substitute x = 2.' })
  const owner = new pg.Client({ connectionString: h.test.ownerUrl })
  await owner.connect()
  return { h, admin, prof, stu, stu2, courseId, cFunctions, cLimits, owner, async close() { await owner.end(); await h.close() } }
}

export interface SseEvent { event: string; data: any }
/** POST and parse a text/event-stream response into events. */
export async function postSse(h: Harness, path: string, token: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; events: SseEvent[]; json?: any }> {
  const res = await fetch(h.url + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal })
  const text = await res.text()
  if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) return { status: res.status, events: [], json: text ? JSON.parse(text) : null }
  const events = text.split('\n\n').filter((b) => b.trim()).map((block) => {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data += line.slice(6)
    }
    return { event, data: JSON.parse(data) }
  })
  return { status: res.status, events }
}
