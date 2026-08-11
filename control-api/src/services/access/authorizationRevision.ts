import { createHash } from 'node:crypto'
import type { TeamRole } from '../../profileTypes.js'
import { type Capability, normalizeCapabilities } from './capabilityRegistry.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'

export type AuthorizationMembershipSnapshot = {
  teamId: string
  role: TeamRole
  membershipUpdatedAt: string
  teamRevision: number
}

export type AuthorizationGrantCandidate = {
  kind: 'direct' | 'team'
  grantId: string
  teamId?: string
  currentRole?: TeamRole
  capabilities: Capability[]
  budgetRef: string | null
  credentialPolicyRef: string | null
  approvalPolicyRef: string | null
  filesystemScopeRef: string | null
  runtimeRef: string | null
  providerModelPolicyRef: string | null
  auditSubject: string
}

const AUTHORIZATION_REVISION_SET_PREFIX = 'ars1.'

function revisionComponents(value: number | string): string[] {
  const text = String(value)
  if (!text.startsWith(AUTHORIZATION_REVISION_SET_PREFIX)) return [text]
  try {
    const decoded = JSON.parse(
      Buffer.from(text.slice(AUTHORIZATION_REVISION_SET_PREFIX.length), 'base64url').toString(
        'utf8'
      )
    ) as unknown
    return Array.isArray(decoded) && decoded.every(item => typeof item === 'string')
      ? decoded
      : [text]
  } catch {
    return [text]
  }
}

export function mergeAuthorizationRevisionValues(values: readonly (number | string)[]): string {
  const normalized = [...new Set(values.flatMap(revisionComponents))].sort()
  if (normalized.length === 1) return normalized[0]!
  return `${AUTHORIZATION_REVISION_SET_PREFIX}${Buffer.from(JSON.stringify(normalized)).toString(
    'base64url'
  )}`
}

export function bindAuthorizationRelationships(
  revision: number | string,
  relationships: readonly { type: string; targetResourceId: string }[]
): string {
  if (relationships.length === 0) return String(revision)
  const projection = relationships
    .map(relationship => [relationship.type, relationship.targetResourceId])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(['authorization_relationships_v1', projection]))
    .digest('base64url')
  return mergeAuthorizationRevisionValues([revision, `relationships:${fingerprint}`])
}

export function resourceAuthorizationRevision(input: {
  userId: string
  userRevision: number
  sessionVersion: number
  memberships: readonly AuthorizationMembershipSnapshot[]
  resource: CanonicalResourceIdentity
  resourceRevision: number | string
  candidates: readonly AuthorizationGrantCandidate[]
}): string {
  const candidateProjection = input.candidates.map(candidate => [
    candidate.kind,
    candidate.grantId,
    candidate.teamId ?? null,
    candidate.currentRole ?? null,
    normalizeCapabilities(candidate.capabilities),
    candidate.budgetRef,
    candidate.credentialPolicyRef,
    candidate.approvalPolicyRef,
    candidate.filesystemScopeRef,
    candidate.runtimeRef,
    candidate.providerModelPolicyRef,
    candidate.auditSubject,
  ])

  return createHash('sha256')
    .update(
      JSON.stringify([
        'authorization_revision_v1',
        input.userId,
        input.userRevision,
        input.sessionVersion,
        input.memberships.map(membership => [
          membership.teamId,
          membership.role,
          membership.membershipUpdatedAt,
          membership.teamRevision,
        ]),
        input.resource.environmentId,
        input.resource.type,
        input.resource.logicalId,
        String(input.resourceRevision),
        candidateProjection.sort((left, right) =>
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ),
      ])
    )
    .digest('base64url')
}
