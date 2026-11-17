import { fileURLToPath } from 'node:url'
import type { ModuleManifest } from '@platform/contracts'

/**
 * Second example module: optionally subscribes to examples.hello's event. Proves that a subscriber
 * keeps working when the publisher module is removed (the subscription is optional).
 */
export const manifest: ModuleManifest = {
  id: 'examples.echo',
  vertical: 'examples',
  version: '0.1.0',
  owner: 'platform-team',
  description: 'Reference module: counts greetings via events',
  db: { schema: 'examples_echo', migrationsDir: fileURLToPath(new URL('../db/migrations', import.meta.url)) },
  permissions: [{ key: 'examples.echo:echo.read', description: 'Read echoes', roles: ['student', 'educator', 'tenant_admin'] }],
  routes: (deps) => [
    {
      method: 'GET', path: '/echoes', permission: 'examples.echo:echo.read',
      handler: async ({ principal }) => deps.inTenant(principal, async (tx) => (await tx.query('select source_id from examples_echo.echoes order by created_at')).rows),
    },
  ],
  events: {
    subscribes: [{
      topic: 'examples.hello.greeted.v1', optional: true,
      handler: () => async (event, ctx) => {
        await ctx.inTenant((tx) => tx.query('insert into examples_echo.echoes (tenant_id, source_id) values (platform.current_tenant(), $1) on conflict do nothing', [(event.payload as { id: string }).id]))
      },
    }],
  },
  ui: { routes: [{ path: '/app/examples/echo', title: 'Echo', permission: 'examples.echo:echo.read' }] },
  data: { stores: [{ kind: 'schema', name: 'examples_echo', onRemove: 'export_then_drop', description: 'echo counters' }] },
}
