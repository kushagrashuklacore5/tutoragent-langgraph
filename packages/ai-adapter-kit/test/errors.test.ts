import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyHttpError, retryAfterMs } from '../src/errors.ts'

const groq429 = '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-20b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7500, Requested 900. Please try again in 2.94s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}'

test('rate limits are transient even when the message mentions billing; real quota stays terminal', () => {
  assert.equal(classifyHttpError(429, groq429), 'rate_limited')
  assert.equal(classifyHttpError(429, '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota, please check your plan and billing details."}}'), 'quota_exhausted')
  assert.equal(classifyHttpError(429, 'Too Many Requests'), 'rate_limited')
})

test('tool_use_failed (unrequested tool call) is a retryable provider glitch, other 400s are not', () => {
  assert.equal(classifyHttpError(400, '{"error":{"message":"Tool choice is none, but model called a tool","code":"tool_use_failed"}}'), 'provider_error')
  assert.equal(classifyHttpError(400, '{"error":{"message":"bad field"}}'), 'invalid_request')
  assert.equal(classifyHttpError(400, '{"error":{"message":"Failed to generate JSON. Please adjust your prompt.","code":"json_validate_failed"}}'), 'provider_error')
})

test('retry-after parsing: header seconds, HTTP date, and body hints', () => {
  assert.equal(retryAfterMs('', '3'), 3000)
  assert.ok(Math.abs(retryAfterMs('', new Date(Date.now() + 5000).toUTCString())! - 5000) < 1500)
  assert.equal(retryAfterMs(groq429), 2940)
  assert.equal(retryAfterMs('Please try again in 1m30.5s.'), 90500)
  assert.equal(retryAfterMs('please try again in 450ms'), 450)
  assert.equal(retryAfterMs('try again later'), undefined)
})
