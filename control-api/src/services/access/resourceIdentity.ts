export const RESOURCE_TYPES = [
  'user',
  'team',
  'host',
  'context',
  'mcp_server',
  'workflow_recipe',
  'workflow_run',
  'workflow_artifact',
  'workflow_approval',
  'gfs_resource',
  'shared_filesystem',
  'sandbox_app',
  'chat',
  'runtime_session',
  'notification',
] as const

export type ResourceType = (typeof RESOURCE_TYPES)[number]

export type CanonicalResourceIdentity = {
  environmentId: string
  type: ResourceType
  canonicalId: string
  logicalId: string
  displayName: string
  providerUid?: string
}

function required(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

export function canonicalResourceIdentity(input: {
  environmentId: string
  type: ResourceType
  logicalId: string
  displayName: string
  providerUid?: string | null
}): CanonicalResourceIdentity {
  const environmentId = required(input.environmentId, 'environmentId')
  const logicalId = required(input.logicalId, 'logicalId')
  const displayName = required(input.displayName, 'displayName')
  return {
    environmentId,
    type: input.type,
    canonicalId: `${input.type}:${logicalId}`,
    logicalId,
    displayName,
    ...(input.providerUid?.trim() ? { providerUid: input.providerUid.trim() } : {}),
  }
}

export function resourceIdentityKey(resource: CanonicalResourceIdentity): string {
  return JSON.stringify([resource.environmentId, resource.type, resource.logicalId])
}

export function sameResourceIdentity(
  left: CanonicalResourceIdentity,
  right: CanonicalResourceIdentity
): boolean {
  return resourceIdentityKey(left) === resourceIdentityKey(right)
}
