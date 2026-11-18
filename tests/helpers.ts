import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devNoopScanner, localObjectStore } from '@platform/documents'
import { migrate } from '@platform/tenancy-db'
import { createDatabase } from '@platform/tenancy-db'
import { createSystemDatabase } from '@platform/tenancy-db/system'
import { createTestDatabase, type TestDatabase } from '@platform/tenancy-db/testing'
import { memoryTransport } from '@platform/identity'
import { ADAPTERS, localKeyManager } from '@platform/ai-gateway'
import { createFakeAdapter, type FakeBehaviour } from '@platform/ai-gateway/testing'
import { configureLogging } from '@platform/observability'
import type { MathChecker, ModuleManifest } from '@platform/contracts'
import { migrationSetsFor } from '@platform/module-runtime'
import { createApp, type App } from '@platform/app-api'

export const KM = localKeyManager(randomBytes(32))

export interface Harness {
  test: TestDatabase
  app: App
  url: string
  mail: ReturnType<typeof memoryTransport>
  fake: ReturnType<typeof createFakeAdapter>
  close(): Promise<void>
  /** sign in through the real HTTP endpoints; returns a bearer token */
  signIn(slug: string, email: string): Promise<string>
  call(method: string, path: string, token?: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>
}

/** Start the API (in-process HTTP server) on a fresh database with the given modules. */
export async function startHarness(modules: ModuleManifest[], opts: { test?: TestDatabase; migrate?: boolean; fake?: FakeBehaviour; documents?: boolean; math?: MathChecker } = {}): Promise<Harness> {
  if (!process.env.TEST_VERBOSE) configureLogging({ level: 'error', sink: () => undefined })
  const test = opts.test ?? (await createTestDatabase('api'))
  if (opts.migrate !== false) await migrate(test.ownerUrl, migrationSetsFor(modules))
  const db = createDatabase(test.appUrl, { max: 5 })
  const system = createSystemDatabase(test.systemUrl, { max: 5 })
  const mail = memoryTransport()
  const fake = createFakeAdapter('fake', opts.fake)
  const app = createApp({
    env: 'test', db, system, keyManager: KM, mail, publicBaseUrl: 'http://app.test', allowedOrigins: ['http://app.test'],
    modules, adapters: { ...ADAPTERS, fake }, moduleCacheMs: 0, math: opts.math,
    documents: opts.documents ? { store: localObjectStore(join(tmpdir(), `ebdocs-${randomBytes(4).toString('hex')}`), randomBytes(32)), scanner: devNoopScanner, embeddingDimensions: 256 } : undefined,
  })
  const server = http.createServer((req, res) => void app.handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const call: Harness['call'] = async (method, path, token, body, headers = {}) => {
    const res = await fetch(url + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = text }
    return { status: res.status, json }
  }
  return {
    test, app, url, mail, fake, call,
    async signIn(slug, email) {
      mail.sent.length = 0
      await call('POST', '/api/auth/magic-link', undefined, { tenantSlug: slug, email })
      const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.sent.at(-1)?.text ?? '')?.[1]
      if (!token) throw new Error(`no magic link for ${email}`)
      const r = await call('POST', '/api/auth/verify', undefined, { token, ageAttestation: 'adult' })
      if (r.status !== 200) throw new Error(`verify failed: ${JSON.stringify(r.json)}`)
      return r.json.sessionToken as string
    },
    async close() {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
      await db.close()
      await system.close()
      if (!opts.test) await test.drop()
    },
  }
}
