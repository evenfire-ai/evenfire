import type { TeamRole } from '../../profileTypes.js'

export const ACCESS_CAPABILITIES = [
  'user.profile.read',
  'team.read',
  'team.manage',
  'team.member.read',
  'team.member.invite',
  'team.member.manage',
  'host.read',
  'host.use',
  'host.manage',
  'host.activity.read',
  'host.activity.read_all',
  'context.read',
  'context.use',
  'context.manage',
  'mcp_server.read',
  'mcp_server.use',
  'workflow.read',
  'workflow.trigger',
  'workflow.run.manage',
  'workflow.artifact.read',
  'workflow.artifact.delete',
  'workflow.approval.decide',
  'gfs.read',
  'gfs.write',
  'gfs.delete',
  'gfs.manage_acl',
  'gfs.share',
  'shared_filesystem.read',
  'shared_filesystem.write',
  'sandbox_app.read',
  'sandbox_app.use',
  'sandbox_oauth.vend',
  'remote_desktop.use',
  'chat.read',
  'chat.message.invoke',
  'task.read',
  'task.manage',
  'model.read',
  'model.select',
  'session.read',
  'session.manage',
  'notification.read',
] as const

export type AccessCapability = (typeof ACCESS_CAPABILITIES)[number]

const capabilities = new Set<string>(ACCESS_CAPABILITIES)

export function isAccessCapability(value: unknown): value is AccessCapability {
  return typeof value === 'string' && capabilities.has(value)
}

export function requireAccessCapability(value: unknown): AccessCapability {
  if (!isAccessCapability(value)) throw new Error('capability_unknown')
  return value
}

export function normalizeAccessCapabilities(values: readonly unknown[]): AccessCapability[] {
  const normalized = new Set<AccessCapability>()
  for (const value of values) normalized.add(requireAccessCapability(value))
  return [...normalized].sort()
}

export function capabilitiesForTeamRole(role: TeamRole): AccessCapability[] {
  const values: AccessCapability[] = ['team.read']
  if (role === 'admin') {
    values.push('team.manage', 'team.member.read', 'team.member.invite', 'team.member.manage')
  } else if (role === 'inviter') {
    values.push('team.member.read', 'team.member.invite')
  }
  return normalizeAccessCapabilities(values)
}

export function gfsPermissionsToCapabilities(value: unknown): AccessCapability[] {
  if (!Array.isArray(value)) return []
  return normalizeAccessCapabilities(
    value.flatMap(permission => {
      const capability = `gfs.${String(permission)}`
      return isAccessCapability(capability) ? [capability] : []
    })
  )
}
