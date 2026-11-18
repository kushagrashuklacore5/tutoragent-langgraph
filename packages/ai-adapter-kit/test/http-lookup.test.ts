import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpClient } from '../src/http.ts'

/**
 * Regression: Node's happy-eyeballs connect calls the lookup hook with { all: true } and expects an
 * address list. Hostname-based providers (Groq, OpenAI, …) failed with ERR_INVALID_IP_ADDRESS while
 * literal-IP providers (local Ollama) worked, because literals skip DNS.
 */
test('hostname destinations connect through the guarded lookup (all: true shape)', async () => {
  const server = http.createServer((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"ok":true}') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  try {
    const client = createHttpClient({ allowPrivateNetwork: true, allowHttp: true } as never, { resolver: async () => [{ address: '127.0.0.1', family: 4 }] })
    const res = await client.request({ method: 'GET', url: `http://provider.test:${port}/v1/models`, timeoutMs: 5000 } as never)
    assert.equal((res as { status: number }).status, 200)
  } finally { server.close() }
})

test('a hostname resolving to a private address is still blocked', async () => {
  const client = createHttpClient({ allowPrivateNetwork: false } as never, { resolver: async () => [{ address: '10.0.0.5', family: 4 }, { address: '93.184.216.34', family: 4 }] })
  await assert.rejects(client.request({ method: 'GET', url: 'https://provider.test/v1/models', timeoutMs: 3000 } as never))
})
