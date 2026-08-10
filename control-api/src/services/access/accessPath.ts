import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'
import { type Capability, normalizeCapabilities } from './capabilityRegistry.js'
import { type CanonicalResourceIdentity, resourceIdentityKey } from './resourceIdentity.js'

export type AccessPathKind = 'direct' | 'team'

export type AccessPathBehavior = {
  capabilities: readonly Capability[]
  budgetRef: string | null
  credentialPolicyRef: string | null
  approvalPolicyRef: string | null
  filesystemScopeRef: string | null
  runtimeRef: string | null
  providerModelPolicyRef: string | null
  auditSubject: string
}

export type AccessPath = {
  id: string
  kind: AccessPathKind
  grantId: string
  teamId?: string
  currentRole?: 'admin' | 'inviter' | 'member'
  authorizationRevision: string
  behavior: AccessPathBehavior & { capabilities: Capability[] }
}

type BuildAccessPathInput = {
  principalUserId: string
  resource: CanonicalResourceIdentity
  kind: AccessPathKind
  grantId: string
  teamId?: string
  currentRole?: 'admin' | 'inviter' | 'member'
  authorizationRevision: string
  behavior: AccessPathBehavior
}

function canonicalBehavior(behavior: AccessPathBehavior) {
  return {
    capabilities: normalizeCapabilities(behavior.capabilities),
    budgetRef: behavior.budgetRef,
    credentialPolicyRef: behavior.credentialPolicyRef,
    approvalPolicyRef: behavior.approvalPolicyRef,
    filesystemScopeRef: behavior.filesystemScopeRef,
    runtimeRef: behavior.runtimeRef,
    providerModelPolicyRef: behavior.providerModelPolicyRef,
    auditSubject: behavior.auditSubject,
  }
}

function signingValue(input: BuildAccessPathInput): string {
  return JSON.stringify([
    'access_path_v1',
    input.principalUserId,
    resourceIdentityKey(input.resource),
    input.kind,
    input.grantId,
    input.teamId ?? null,
    input.authorizationRevision,
    canonicalBehavior(input.behavior),
  ])
}

function handleFor(input: BuildAccessPathInput): string {
  const digest = createHmac('sha256', config.sessionJwtPrivateKey)
    .update(signingValue(input), 'utf8')
    .digest('base64url')
  return `ap1_${digest}`
}

export function buildAccessPath(input: BuildAccessPathInput): AccessPath {
  if (
    !input.principalUserId.trim() ||
    !input.grantId.trim() ||
    !input.authorizationRevision.trim()
  ) {
    throw new Error('access path identity is incomplete')
  }
  if (input.kind === 'team' && !input.teamId?.trim()) {
    throw new Error('team access path requires teamId')
  }
  if (input.kind === 'direct' && input.teamId) {
    throw new Error('direct access path cannot carry teamId')
  }
  const behavior = canonicalBehavior(input.behavior)
  return {
    id: handleFor(input),
    kind: input.kind,
    grantId: input.grantId,
    ...(input.teamId ? { teamId: input.teamId } : {}),
    ...(input.currentRole ? { currentRole: input.currentRole } : {}),
    authorizationRevision: input.authorizationRevision,
    behavior,
  }
}

export function accessPathIdMatches(id: string, input: BuildAccessPathInput): boolean {
  const expected = handleFor(input)
  const suppliedBytes = Buffer.from(id)
  const expectedBytes = Buffer.from(expected)
  return (
    suppliedBytes.length === expectedBytes.length && timingSafeEqual(suppliedBytes, expectedBytes)
  )
}

function behaviorFingerprint(path: AccessPath): string {
  return JSON.stringify(canonicalBehavior(path.behavior))
}

export function accessPathsAreEquivalent(left: AccessPath, right: AccessPath): boolean {
  return behaviorFingerprint(left) === behaviorFingerprint(right)
}

function canonicalSelectionKey(path: AccessPath): string {
  return JSON.stringify([
    path.kind === 'direct' ? 0 : 1,
    path.kind,
    path.teamId ?? '',
    path.grantId,
  ])
}

export function selectEquivalentAccessPath(paths: readonly AccessPath[]): AccessPath | null {
  if (paths.length === 0) return null
  if (!paths.every(path => accessPathsAreEquivalent(paths[0], path))) return null
  return [...paths].sort((left, right) =>
    canonicalSelectionKey(left).localeCompare(canonicalSelectionKey(right))
  )[0]
}
