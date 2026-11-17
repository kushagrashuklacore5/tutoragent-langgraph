import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const run = () => spawnSync(process.execPath, [join(root, 'tooling/check-boundaries.ts')], { encoding: 'utf8' })

/** Each planted file must make the boundary check fail with the expected rule. */
const CASES: { file: string; src: string; expect: RegExp }[] = [
  { file: 'modules/examples/hello-agent/src/__v1.ts', src: "import { createGateway } from '@platform/ai-gateway'\n", expect: /modules may not import @platform\/ai-gateway \(M1\)/ },
  { file: 'modules/examples/hello-agent/src/__v2.ts', src: "import { manifest } from '@modules/examples-echo-agent'\n", expect: /must not import other modules/ },
  { file: 'modules/examples/hello-agent/src/__v3.ts', src: "import x from '../../echo-agent/src/manifest.ts'\n", expect: /escapes the module/ },
  { file: 'modules/examples/hello-agent/src/__v4.ts', src: "import OpenAI from 'openai'\n", expect: /vendor SDK/ },
  { file: 'modules/examples/hello-agent/src/__v5.ts', src: "export const m = 'gpt-4o-mini'\n", expect: /hard-coded provider model id/ },
  { file: 'modules/examples/hello-agent/src/__v6.ts', src: "import { createSystemDatabase } from '@platform/tenancy-db/system'\n", expect: /privileged system database/ },
  { file: 'packages/core/src/__v7.ts', src: "import { manifest } from '@modules/examples-hello-agent'\n", expect: /packages must not import modules/ },
  { file: 'packages/ai-adapters/groq/src/__v8.ts', src: "import { adapter } from '@platform/ai-adapter-openai'\n", expect: /must not import other adapters/ },
  { file: 'packages/jobs/src/__v9.ts', src: "import { createGateway } from '@platform/ai-gateway'\n", expect: /layer rule/ },
  { file: 'apps/api/src/__v10.ts', src: "const u = 'https://api.openai.com/v1'\n", expect: /vendor hostname/ },
]

test('the current tree has no boundary violations', () => {
  const r = run()
  assert.equal(r.status, 0, r.stderr)
})

for (const c of CASES) {
  test(`detects: ${c.file}`, () => {
    const p = join(root, c.file)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, c.src)
    try {
      const r = run()
      assert.equal(r.status, 1)
      assert.match(r.stderr, c.expect)
    } finally {
      rmSync(p)
    }
  })
}
