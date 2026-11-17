/**
 * Recorded mode: every registered adapter runs the same suite against a deterministic mock of its
 * protocol. Runs on every pull request, offline.
 */
import { before, after, describe } from 'node:test'
import { NO_CAPABILITIES, type Capabilities } from '@platform/ai-adapter-kit'
import { ADAPTERS } from '../src/adapters.generated.ts'
import { defineConformanceSuite } from './suite.ts'
import { MOCK_KEY, startMock, type Protocol } from './mocks.ts'

const PROTOCOL: Record<string, Protocol> = {
  openai: 'openai',
  groq: 'openai',
  'openai-compatible': 'openai',
  anthropic: 'anthropic',
  'google-gemini': 'gemini',
  ollama: 'ollama',
}
/** What each mocked model declares; mirrors what a registry entry would claim for a capable model. */
const DECLARED: Record<string, Partial<Capabilities>> = {
  openai: { structuredOutput: 'json_schema', tools: 'parallel', forcedToolChoice: true, embeddingDimensions: [8] },
  groq: { structuredOutput: 'json_mode', tools: 'parallel', forcedToolChoice: true },
  'openai-compatible': { structuredOutput: 'json_mode', tools: 'single', forcedToolChoice: true, embeddingDimensions: [8] },
  anthropic: { structuredOutput: 'json_mode', tools: 'parallel', forcedToolChoice: true },
  'google-gemini': { structuredOutput: 'json_schema', tools: 'parallel', forcedToolChoice: true, embeddingDimensions: [8] },
  ollama: { structuredOutput: 'json_schema', tools: 'single', forcedToolChoice: false, embeddingDimensions: [8] },
}

for (const adapter of Object.values(ADAPTERS)) {
  const type = adapter.descriptor.type
  const protocol = PROTOCOL[type]
  if (!protocol) throw new Error(`No mock protocol registered for adapter ${type}; add it to the conformance harness`)
  describe(`conformance: ${type}`, () => {
    let mock: Awaited<ReturnType<typeof startMock>>
    const target = {
      name: type,
      adapter,
      mode: 'recorded' as const,
      baseUrl: '',
      apiKey: MOCK_KEY,
      chatModel: 'mock-chat',
      embedModel: adapter.descriptor.operations.includes('embed') ? 'mock-embed' : undefined,
      declared: { ...NO_CAPABILITIES, operations: adapter.descriptor.operations, ...DECLARED[type] },
      errorModels: true,
    }
    before(async () => {
      mock = await startMock(protocol)
      target.baseUrl = mock.baseUrl
    })
    after(() => mock.close())
    defineConformanceSuite(target)
  })
}
