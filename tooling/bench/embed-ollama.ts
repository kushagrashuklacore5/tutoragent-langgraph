/**
 * Embedding micro-benchmark against local Ollama (no database):
 *   node tooling/bench/embed-ollama.ts [model=qwen3-embedding:0.6b]
 * Separates cold load, warm single-query latency and per-chunk cost at different batch sizes.
 */
import { ADAPTERS } from '@platform/ai-gateway'
import { createHttpClient } from '@platform/ai-adapter-kit'

const model = process.argv[2] ?? 'qwen3-embedding:0.6b'
const conn = { id: 'bench', baseUrl: 'http://127.0.0.1:11434', http: createHttpClient({ requireHttps: false, allowPrivateNetwork: true }), timeoutMs: 600_000 }
const embed = ADAPTERS.ollama!.embed!
const chunk = (i: number) => `Unit ${i}. Newton second law states that the net force on a body equals its mass times acceleration. ` +
  'Worked example: a 2 kg block accelerates at 3 m/s^2, so the net force is 6 N. '.repeat(6)
const time = async (fn: () => Promise<unknown>) => { const t = performance.now(); await fn(); return performance.now() - t }

const out: Record<string, unknown> = { model, chunkChars: chunk(0).length }
out.coldFirstQueryMs = Math.round(await time(() => embed(conn, model, { inputs: ['what is force'], purpose: 'query' })))
const warm: number[] = []
for (let i = 0; i < 5; i++) warm.push(await time(() => embed(conn, model, { inputs: [`what is force ${i}`], purpose: 'query' })))
out.warmQueryMs = Math.round(warm.sort((a, b) => a - b)[2]!)
for (const b of [1, 8, 16, 32]) {
  const n = 32
  let ms = 0
  for (let i = 0; i < n; i += b) ms += await time(() => embed(conn, model, { inputs: Array.from({ length: Math.min(b, n - i) }, (_, k) => chunk(i + k)), purpose: 'document' }))
  out[`batch${b}_msPerChunk`] = Math.round(ms / n)
}
console.log(JSON.stringify(out))
