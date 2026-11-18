import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChatBody } from '@platform/ai-adapter-kit'
import { adapter } from '../src/index.ts'

test('Groq: json_schema is sent best-effort (strict:false); OpenAI-style default stays strict', () => {
  const req = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 10, responseFormat: { type: 'json' as const, mode: 'json_schema' as const, name: 't', schema: { type: 'object', properties: { a: { type: 'string' } } } } }
  const groqOpts = { provider: 'Groq', maxTokensField: 'max_completion_tokens' as const, streamUsage: false, reasoningEffort: true, requiresKey: true, strictSchema: false }
  const g = buildChatBody('openai/gpt-oss-20b', req as never, groqOpts, false) as { response_format: { json_schema: { strict: boolean } }; max_completion_tokens: number }
  assert.equal(g.response_format.json_schema.strict, false)
  assert.equal(g.max_completion_tokens, 10)
  const d = buildChatBody('gpt-x', req as never, { ...groqOpts, strictSchema: undefined }, false) as { response_format: { json_schema: { strict: boolean } } }
  assert.equal(d.response_format.json_schema.strict, true)
  assert.equal(adapter.descriptor.defaultBaseUrl, 'https://api.groq.com/openai/v1')
})
