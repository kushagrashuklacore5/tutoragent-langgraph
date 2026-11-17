import {
  openAiEmbed, openAiGenerate, openAiListModels, openAiStream, openAiTest,
  type OpenAiStyleOptions, type ProviderAdapter,
} from '@platform/ai-adapter-kit'

/**
 * Generic OpenAI-compatible endpoint (vLLM, LM Studio, other compatible servers).
 * No default base URL; API key optional; conservative request fields. Capabilities are never
 * assumed for this adapter — every deployment must be probed before routing.
 */
const o: OpenAiStyleOptions = { provider: 'OpenAI-compatible', maxTokensField: 'max_tokens', streamUsage: false, reasoningEffort: false, requiresKey: false }

export const adapter: ProviderAdapter = {
  descriptor: {
    type: 'openai-compatible',
    version: '1.0.0',
    displayName: 'OpenAI-compatible endpoint',
    operations: ['generate', 'stream', 'embed'],
    requiresApiKey: false,
    supportsDiscovery: true,
    supportsPrivateNetwork: true,
  },
  testConnection: (c) => openAiTest(c, o),
  listModels: (c) => openAiListModels(c, o),
  generate: (c, m, r, s) => openAiGenerate(c, m, r, o, s),
  stream: (c, m, r, s) => openAiStream(c, m, r, o, s),
  embed: (c, m, r, s) => openAiEmbed(c, m, r, o, s),
}
export default adapter
