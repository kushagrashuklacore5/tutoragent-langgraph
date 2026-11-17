import { AppError, forbidden } from '@platform/core'

/** Roles a user can hold inside a tenant. Platform admin is a separate, global flag. */
export const ROLES = ['student', 'educator', 'tenant_admin'] as const
export type Role = (typeof ROLES)[number]

export interface PermissionDef {
  key: string
  description: string
  /** roles granted this permission by default */
  roles: Role[]
  /** registering owner: 'platform' or a module id */
  owner: string
}

const KEY = /^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.]*$/

/**
 * Registry of every permission in the running system. Platform permissions are registered at
 * startup; module permissions come only from module manifests and must be namespaced `<module-id>:`.
 */
export class PermissionRegistry {
  private defs = new Map<string, PermissionDef>()

  define(def: PermissionDef): void {
    if (!KEY.test(def.key)) throw new AppError('permission_invalid', `Invalid permission key ${def.key}`)
    const ns = def.key.split(':')[0]
    if (def.owner !== 'platform' && ns !== def.owner) throw new AppError('permission_namespace', `Permission ${def.key} must be namespaced ${def.owner}:`)
    if (def.owner === 'platform' && ns !== 'platform') throw new AppError('permission_namespace', `Platform permission ${def.key} must start with platform:`)
    if (this.defs.has(def.key)) throw new AppError('permission_duplicate', `Permission ${def.key} already defined`)
    this.defs.set(def.key, def)
  }

  has(key: string): boolean {
    return this.defs.has(key)
  }
  list(): PermissionDef[] {
    return [...this.defs.values()].sort((a, b) => a.key.localeCompare(b.key))
  }

  /** Effective check. Unknown keys are denied (e.g. a removed module's permission). */
  allows(principal: { roles: string[]; isPlatformAdmin: boolean }, key: string): boolean {
    const def = this.defs.get(key)
    if (!def) return false
    if (principal.isPlatformAdmin) return true
    return def.roles.some((r) => principal.roles.includes(r))
  }

  assert(principal: { roles: string[]; isPlatformAdmin: boolean }, key: string): void {
    if (!this.allows(principal, key)) throw forbidden(`Missing permission ${key}`)
  }
}

export function definePlatformPermissions(reg: PermissionRegistry): void {
  const p = (key: string, description: string, roles: Role[]) => reg.define({ key, description, roles, owner: 'platform' })
  p('platform:session.read', 'Read own session and profile', ['student', 'educator', 'tenant_admin'])
  p('platform:members.read', 'List tenant members', ['educator', 'tenant_admin'])
  p('platform:members.manage', 'Invite, change roles of and disable members', ['tenant_admin'])
  p('platform:audit.read', 'Read the tenant audit log', ['tenant_admin'])
  p('platform:ai.usage.read', 'Read AI usage and cost for the tenant', ['tenant_admin'])
  p('platform:ai.connections.tenant', 'Manage tenant-scoped (BYOK) AI connections, if enabled', ['tenant_admin'])
  p('platform:ai.admin', 'Manage platform AI connections, models and routes (platform admins only)', [])
}
