import {
  ACCESS_RESOURCE_TYPES,
  type AccessResourceTypeWire,
  type CanonicalResourceIdentityWire,
  canonicalResourceIdentity as canonicalSharedResourceIdentity,
  isAccessResourceType,
  requireAccessResourceType,
  validateLogicalResourceId,
} from '@clerum/action-context-contracts'

export {
  ACCESS_RESOURCE_TYPES,
  isAccessResourceType,
  requireAccessResourceType,
  validateLogicalResourceId,
}
export type AccessResourceType = AccessResourceTypeWire
export type CanonicalResourceIdentity = CanonicalResourceIdentityWire

export function canonicalResourceIdentity(input: {
  environmentId: unknown
  type: unknown
  logicalId: unknown
  displayName?: unknown
  providerUid?: unknown
}): CanonicalResourceIdentity {
  return canonicalSharedResourceIdentity(input)
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
