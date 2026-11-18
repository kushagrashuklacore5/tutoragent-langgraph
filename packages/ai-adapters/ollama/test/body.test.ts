import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBody, thinkValue } from '../src/index.ts'

test('think: graded levels only for gpt-oss; boolean for other thinking models', () => {
  assert.equal(thinkValue('qwen3:1.7b', 'low'), false, 'qwen3 would treat "low" as think=true and exhaust the budget')
  assert.equal(thinkValue('qwen3:4b', 'medium'), true)
  assert.equal(thinkValue('deepseek-r1:7b', 'high'), true)
  assert.equal(thinkValue('qwen3:4b', 'off'), false)
  assert.equal(thinkValue('gpt-oss:20b', 'low'), 'low')
  assert.equal(thinkValue('gpt-oss', 'high'), 'high')
  assert.equal(thinkValue('gpt-oss:20b', 'off'), false)
})

test('request body: JSON mode, schema mode, and reasoning mapping', () => {
  const base = { messages: [{ role: 'user' as const, content: 'hi' }], maxOutputTokens: 50 }
  assert.equal(buildBody('qwen3:1.7b', { ...base, responseFormat: { type: 'json', mode: 'json_mode' }, reasoning: 'low' } as never, false).think, false)
  assert.equal(buildBody('qwen3:1.7b', { ...base, responseFormat: { type: 'json', mode: 'json_mode' } } as never, false).format, 'json')
  const schema = { type: 'object' }
  assert.equal(buildBody('m', { ...base, responseFormat: { type: 'json', mode: 'json_schema', schema } } as never, true).format, schema)
  assert.equal('think' in buildBody('m', base as never, false), false, 'no reasoning requested → model default')
})
