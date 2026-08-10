export const CAPABILITIES = [
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

export type Capability = (typeof CAPABILITIES)[number]

const capabilitySet = new Set<string>(CAPABILITIES)

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && capabilitySet.has(value)
}

export function requireKnownCapability(value: unknown): Capability {
  if (!isCapability(value)) throw new Error(`unknown capability: ${String(value)}`)
  return value
}

export function normalizeCapabilities(values: readonly unknown[]): Capability[] {
  const normalized = new Set<Capability>()
  for (const value of values) normalized.add(requireKnownCapability(value))
  return [...normalized].sort()
}
