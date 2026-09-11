export const ACCESS_RESOURCE_TYPES = [
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

export type AccessResourceType = (typeof ACCESS_RESOURCE_TYPES)[number]

export type CanonicalResourceIdentity = Readonly<{
  environmentId: string
  type: AccessResourceType
  canonicalId: string
  logicalId: string
  displayName: string
  providerUid?: string
}>

const resourceTypes = new Set<string>(ACCESS_RESOURCE_TYPES)
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DNS_LABEL_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

function boundedText(value: unknown, label: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

export function isAccessResourceType(value: unknown): value is AccessResourceType {
  return typeof value === 'string' && resourceTypes.has(value)
}

export function requireAccessResourceType(value: unknown): AccessResourceType {
  if (!isAccessResourceType(value)) throw new Error('resource_type_invalid')
  return value
}

export function validateLogicalResourceId(type: AccessResourceType, logicalId: string): void {
  if (
    ['user', 'team', 'workflow_run', 'workflow_approval', 'gfs_resource', 'notification'].includes(
      type
    )
  ) {
    if (!UUID_PATTERN.test(logicalId)) throw new Error('resource_logical_id_invalid')
    return
  }
  if (
    [
      'host',
      'context',
      'mcp_server',
      'workflow_recipe',
      'shared_filesystem',
      'sandbox_app',
    ].includes(type)
  ) {
    if (!DNS_LABEL_PATTERN.test(logicalId) || logicalId.length > 507) {
      throw new Error('resource_logical_id_invalid')
    }
  }
}

export function canonicalResourceIdentity(input: {
  environmentId: unknown
  type: unknown
  logicalId: unknown
  displayName?: unknown
  providerUid?: unknown
}): CanonicalResourceIdentity {
  const environmentId = boundedText(input.environmentId, 'environment_id', 512)
  const type = requireAccessResourceType(input.type)
  const logicalId = boundedText(input.logicalId, 'resource_logical_id', 1_024)
  validateLogicalResourceId(type, logicalId)
  const displayName =
    input.displayName === undefined
      ? logicalId
      : boundedText(input.displayName, 'resource_display_name', 512)
  const providerUid =
    input.providerUid === undefined || input.providerUid === null
      ? undefined
      : boundedText(input.providerUid, 'resource_provider_uid', 256)
  return Object.freeze({
    environmentId,
    type,
    canonicalId: `${type}:${logicalId}`,
    logicalId,
    displayName,
    ...(providerUid ? { providerUid } : {}),
  })
}

export function resourceIdentityKey(resource: CanonicalResourceIdentity): string {
  return JSON.stringify([resource.environmentId, resource.type, resource.logicalId])
}

export function compareResourceIdentity(
  left: CanonicalResourceIdentity,
  right: CanonicalResourceIdentity
): number {
  return resourceIdentityKey(left).localeCompare(resourceIdentityKey(right))
}
