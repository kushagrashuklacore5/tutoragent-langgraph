import {
  openAiGenerate, openAiListModels, openAiStream, openAiTest,
  type OpenAiStyleOptions, type ProviderAdapter,
} from '@platform/ai-adapter-kit'

/**
 * Groq adapter. Groq exposes an OpenAI-style API; this adapter keeps Groq's own defaults
 * (base URL, usage reported in `x_groq` on streams, no embeddings) independent of the OpenAI adapter.
 */
const o: OpenAiStyleOptions = { provider: 'Groq', maxTokensField: 'max_completion_tokens', streamUsage: false, reasoningEffort: true, requiresKey: true }

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'groq',
    version: '1.0.0',
    displayName: 'Groq',
    operations: ['generate', 'stream'],
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    supportsDiscovery: true,
    supportsPrivateNetwork: false,
  },
  testConnection: (c) => openAiTest(c, o),
  listModels: (c) => openAiListModels(c, o),
  generate: (c, m, r, s) => openAiGenerate(c, m, r, o, s),
  stream: (c, m, r, s) => openAiStream(c, m, r, o, s),
}
export default adapter
