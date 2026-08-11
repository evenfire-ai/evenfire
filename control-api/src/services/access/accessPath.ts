import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import type { TeamRole } from '../../profileTypes.js'
import { type AccessCapability, normalizeAccessCapabilities } from './capabilityRegistry.js'
import { type CanonicalResourceIdentity, resourceIdentityKey } from './resourceIdentity.js'

export type AccessPathKind = 'direct' | 'team'
export type BehaviorDimension =
  | Readonly<{ state: 'known'; value: string | null }>
  | Readonly<{ state: 'unknown' }>

export type AccessPathBehavior = Readonly<{
  capabilities: readonly AccessCapability[]
  budget: BehaviorDimension
  credentialPolicy: BehaviorDimension
  approvalPolicy: BehaviorDimension
  filesystemScope: BehaviorDimension
  runtime: BehaviorDimension
  providerModelPolicy: BehaviorDimension
  audit: BehaviorDimension
}>

export type AccessPath = Readonly<{
  id: string
  kind: AccessPathKind
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  authorizationRevision: string
  behavior: AccessPathBehavior
}>

export type AccessPathSeed = Readonly<{
  kind: AccessPathKind
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  behavior: AccessPathBehavior
}>

export const knownBehavior = (value: string | null): BehaviorDimension =>
  Object.freeze({ state: 'known', value })
export const unknownBehavior = (): BehaviorDimension => Object.freeze({ state: 'unknown' })

function normalizedBehavior(behavior: AccessPathBehavior): AccessPathBehavior {
  return Object.freeze({
    ...behavior,
    capabilities: Object.freeze(normalizeAccessCapabilities(behavior.capabilities)),
  })
}

function signingValue(input: {
  principalUserId: string
  resource: CanonicalResourceIdentity
  seed: AccessPathSeed
  authorizationRevision: string
}): string {
  return JSON.stringify([
    'access_path_v1',
    input.principalUserId,
    resourceIdentityKey(input.resource),
    input.seed.kind,
    input.seed.grantId,
    input.seed.teamId ?? null,
    input.authorizationRevision,
    normalizedBehavior(input.seed.behavior),
  ])
}

export function buildAccessPath(input: {
  principalUserId: string
  resource: CanonicalResourceIdentity
  seed: AccessPathSeed
  authorizationRevision: string
}): AccessPath {
  if (!input.principalUserId.trim() || !input.seed.grantId.trim() || !input.authorizationRevision) {
    throw new Error('access_path_identity_incomplete')
  }
  if (input.seed.kind === 'team' && !input.seed.teamId?.trim()) {
    throw new Error('access_path_team_missing')
  }
  if (input.seed.kind === 'direct' && input.seed.teamId) {
    throw new Error('access_path_direct_team_invalid')
  }
  const behavior = normalizedBehavior(input.seed.behavior)
  const digest = createHmac('sha256', config.sessionJwtPrivateKey)
    .update(signingValue({ ...input, seed: { ...input.seed, behavior } }), 'utf8')
    .digest('base64url')
  return Object.freeze({
    id: `ap1_${digest}`,
    kind: input.seed.kind,
    grantId: input.seed.grantId,
    ...(input.seed.teamId ? { teamId: input.seed.teamId } : {}),
    ...(input.seed.currentRole ? { currentRole: input.seed.currentRole } : {}),
    authorizationRevision: input.authorizationRevision,
    behavior,
  })
}

function dimensionIsEquivalent(left: BehaviorDimension, right: BehaviorDimension): boolean {
  return left.state === 'known' && right.state === 'known' && left.value === right.value
}

export function accessPathsAreEquivalent(left: AccessPath, right: AccessPath): boolean {
  if (left.id === right.id) return true
  if (JSON.stringify(left.behavior.capabilities) !== JSON.stringify(right.behavior.capabilities)) {
    return false
  }
  return (
    dimensionIsEquivalent(left.behavior.budget, right.behavior.budget) &&
    dimensionIsEquivalent(left.behavior.credentialPolicy, right.behavior.credentialPolicy) &&
    dimensionIsEquivalent(left.behavior.approvalPolicy, right.behavior.approvalPolicy) &&
    dimensionIsEquivalent(left.behavior.filesystemScope, right.behavior.filesystemScope) &&
    dimensionIsEquivalent(left.behavior.runtime, right.behavior.runtime) &&
    dimensionIsEquivalent(left.behavior.providerModelPolicy, right.behavior.providerModelPolicy) &&
    dimensionIsEquivalent(left.behavior.audit, right.behavior.audit)
  )
}

export function canonicalAccessPathTuple(
  path: Pick<AccessPath, 'kind' | 'teamId' | 'grantId'>
): string {
  return JSON.stringify([
    path.kind === 'direct' ? 0 : 1,
    path.kind,
    path.teamId ?? '',
    path.grantId,
  ])
}

export function selectEquivalentAccessPath(paths: readonly AccessPath[]): AccessPath | null {
  if (paths.length === 0) return null
  if (paths.length === 1) return paths[0]
  if (!paths.every(path => accessPathsAreEquivalent(paths[0], path))) return null
  return [...paths].sort((left, right) =>
    canonicalAccessPathTuple(left).localeCompare(canonicalAccessPathTuple(right))
  )[0]
}

export function accessPathHandleEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}
