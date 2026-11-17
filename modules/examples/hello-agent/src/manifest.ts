import { fileURLToPath } from 'node:url'
import { badRequest } from '@platform/core'
import type { ModuleManifest } from '@platform/contracts'

/**
 * Example module used to prove the module contract and removal guarantees. It declares one of
 * everything a module can add: schema, permissions, routes, a job, a published event, a UI route
 * and an AI task.
 */
export const manifest: ModuleManifest = {
  id: 'examples.hello',
  vertical: 'examples',
  version: '0.1.0',
  owner: 'platform-team',
  description: 'Reference module: greetings',
  db: { schema: 'examples_hello', migrationsDir: fileURLToPath(new URL('../db/migrations', import.meta.url)) },
  permissions: [
    { key: 'examples.hello:greeting.read', description: 'Read greetings', roles: ['student', 'educator', 'tenant_admin'] },
    { key: 'examples.hello:greeting.write', description: 'Create greetings', roles: ['student', 'educator', 'tenant_admin'] },
  ],
  routes: (deps) => [
    {
      method: 'GET', path: '/greetings', permission: 'examples.hello:greeting.read',
      handler: async ({ principal }) => deps.inTenant(principal, async (tx) => (await tx.query('select id, text, created_at from examples_hello.greetings order by created_at')).rows),
    },
    {
      method: 'POST', path: '/greetings', permission: 'examples.hello:greeting.write',
      handler: async ({ principal, body }) => {
        const text = (body as { text?: string } | undefined)?.text
        if (!text || text.length > 200) throw badRequest('text_invalid', 'text (1-200 chars) is required')
        return deps.inTenant(principal, async (tx) => {
          const r = await tx.query<{ id: string }>('insert into examples_hello.greetings (tenant_id, text) values (platform.current_tenant(), $1) returning id', [text])
          await deps.enqueue(tx, 'greeting.count', { id: r.rows[0]!.id }, { idempotencyKey: r.rows[0]!.id })
          await deps.publish(tx, 'examples.hello.greeted.v1', { id: r.rows[0]!.id })
          await deps.audit(tx, principal, { action: 'greeting.created', targetType: 'greeting', targetId: r.rows[0]!.id })
          return { id: r.rows[0]!.id }
        })
      },
    },
    {
      method: 'POST', path: '/greetings/ai', permission: 'examples.hello:greeting.write',
      handler: async ({ principal, body }) => {
        const r = await deps.ai(principal).run('examples.hello.compose', { messages: [{ role: 'user', content: String((body as { prompt?: string })?.prompt ?? 'Say hello') }] })
        return { text: r.text, route: r.route }
      },
    },
  ],
  jobs: (deps) => ({
    'greeting.count': async (ctx) => {
      await ctx.inTenant((tx) => tx.query('update examples_hello.greetings set processed = true where id = $1', [(ctx.job.payload as { id: string }).id]))
      void deps
    },
  }),
  events: { publishes: ['examples.hello.greeted.v1'] },
  ui: {
    routes: [{ path: '/app/examples/hello', title: 'Hello', permission: 'examples.hello:greeting.read' }],
    nav: [{ label: 'Hello', path: '/app/examples/hello', permission: 'examples.hello:greeting.read' }],
  },
  ai: {
    tasks: [{ id: 'examples.hello.compose', owner: 'examples.hello', category: 'examples_chat', requires: { operation: 'generate' }, dataClass: 'public', determinism: 'flexible', fallback: 'eligible_only' }],
  },
  data: {
    stores: [
      { kind: 'schema', name: 'examples_hello', onRemove: 'export_then_drop', description: 'greetings' },
      { kind: 'audit_events', name: 'examples.hello.*', onRemove: 'retain_platform_policy', description: 'audit trail' },
      { kind: 'ai_operations', name: 'examples.hello', onRemove: 'retain_platform_policy', description: 'AI metering' },
    ],
  },
  evals: { suites: ['examples/compose'] },
}
