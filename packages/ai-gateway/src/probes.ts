import {
  NO_CAPABILITIES, type Capabilities, type GenerateRequest, type ProviderAdapter, type ResolvedConnection, type StreamEvent,
} from '@platform/ai-adapter-kit'

/**
 * Capability probes (AI_GATEWAY.md § 7). Run against a real deployment; only capabilities that
 * actually work become `verified`. Limits (context window, max output) are copied from the declared
 * entry — they are smoke-tested by use, not exhaustively probed.
 */
export interface ProbeReport {
  verified: Capabilities
  checks: { name: string; ok: boolean; detail?: string }[]
}

const SCHEMA = { type: 'object', properties: { answer: { type: 'string' }, n: { type: 'integer' } }, required: ['answer', 'n'], additionalProperties: false }
const TOOL = { name: 'get_weather', description: 'Get the weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }

export async function probeDeployment(adapter: ProviderAdapter, conn: ResolvedConnection, modelId: string, declared: Capabilities): Promise<ProbeReport> {
  const checks: ProbeReport['checks'] = []
  const v: Capabilities = { ...NO_CAPABILITIES, operations: [], contextWindow: declared.contextWindow, maxOutputTokens: declared.maxOutputTokens, embeddingDimensions: [] }
  const base: Partial<GenerateRequest> = { maxOutputTokens: 256, temperature: 0, ...(declared.reasoningControl ? { reasoning: 'off' as const } : {}) }
  const run = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail: detail || undefined })
      return true
    } catch (e) {
      checks.push({ name, ok: false, detail: (e as Error).message.slice(0, 200) })
      return false
    }
  }
  const gen = (r: Partial<GenerateRequest>) => adapter.generate(conn, modelId, { messages: [], ...base, ...r } as GenerateRequest)

  if (declared.operations.includes('generate')) {
    if (await run('generate', async () => { const r = await gen({ messages: [{ role: 'user', content: 'Reply with the word OK.' }] }); if (!r.text.trim()) throw new Error('empty') })) v.operations.push('generate')
  }
  if (declared.operations.includes('stream')) {
    const ok = await run('stream', async () => {
      const ev: StreamEvent[] = []
      for await (const e of adapter.stream(conn, modelId, { messages: [{ role: 'user', content: 'Reply with the word OK.' }], ...base } as GenerateRequest)) ev.push(e)
      if (ev[0]?.t !== 'start' || ev.at(-1)?.t !== 'finish') throw new Error('bad event order')
    })
    if (ok) v.operations.push('stream')
  }
  if (v.operations.includes('generate') && declared.structuredOutput !== 'none') {
    for (const mode of declared.structuredOutput === 'json_schema' ? (['json_schema', 'json_mode'] as const) : (['json_mode'] as const)) {
      const ok = await run(`structured:${mode}`, async () => {
        const r = await gen({
          messages: [{ role: 'system', content: 'Return JSON: {"answer": "ok", "n": 1}' }, { role: 'user', content: 'Give the result as JSON.' }],
          responseFormat: { type: 'json', mode, schema: SCHEMA, name: 'probe' },
        })
        const j = JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, ''))
        if (typeof j.answer !== 'string' || typeof j.n !== 'number') throw new Error('schema mismatch')
      })
      if (ok) {
        v.structuredOutput = mode
        break
      }
    }
  }
  if (v.operations.includes('generate') && declared.tools !== 'none') {
    const choice = declared.forcedToolChoice ? 'required' : 'auto'
    const ok = await run(`tools:${choice}`, async () => {
      const r = await gen({ messages: [{ role: 'user', content: 'What is the weather in Pune? Please call tool get_weather.' }], tools: [TOOL], toolChoice: choice })
      if (r.toolCalls[0]?.name !== 'get_weather') throw new Error('no tool call')
    })
    if (ok) {
      v.tools = 'single'
      v.forcedToolChoice = declared.forcedToolChoice
    }
  }
  if (v.operations.includes('generate') && declared.reasoningControl) {
    if (await run('reasoning-control', async () => { await gen({ messages: [{ role: 'user', content: 'Reply OK.' }], reasoning: 'low', maxOutputTokens: 2048 }) })) v.reasoningControl = true
  }
  if (declared.operations.includes('embed') && adapter.embed) {
    const ok = await run('embed', async () => {
      const r = await adapter.embed!(conn, modelId, { inputs: ['probe one', 'probe two'], purpose: 'document' })
      if (r.vectors.length !== 2 || !r.dimensions) throw new Error('bad embeddings')
      v.embeddingDimensions = [r.dimensions]
      return `dimensions=${r.dimensions}`
    })
    if (ok) v.operations.push('embed')
  }
  return { verified: v, checks }
}
