import { createHash } from 'node:crypto'
import type { TeamRole } from '../../profileTypes.js'
import type { AccessPathSeed } from './accessPath.js'
import { type CanonicalResourceIdentity, resourceIdentityKey } from './resourceIdentity.js'

export type AuthorizationMembershipRevision = Readonly<{
  teamId: string
  role: TeamRole
  membershipUpdatedAt: string
  teamRevision: string
}>

export type AuthorizationRevisionInput = Readonly<{
  principalUserId: string
  sessionContract: 'v1' | 'v2'
  sessionRevision: string
  userRevision: string
  memberships: readonly AuthorizationMembershipRevision[]
  resource: CanonicalResourceIdentity
  resourceRevision: string
  sourceStateRevision: string
  relationshipsRevision: string
  candidates: readonly AccessPathSeed[]
}>

function canonicalCandidates(candidates: readonly AccessPathSeed[]) {
  return [...candidates]
    .map(candidate => ({
      kind: candidate.kind,
      grantId: candidate.grantId,
      teamId: candidate.teamId ?? null,
      currentRole: candidate.currentRole ?? null,
      behavior: candidate.behavior,
    }))
    .sort((left, right) =>
      JSON.stringify([left.kind, left.teamId, left.grantId]).localeCompare(
        JSON.stringify([right.kind, right.teamId, right.grantId])
      )
    )
}

export function authorizationRevision(input: AuthorizationRevisionInput): string {
  return `ar1_${createHash('sha256')
    .update(
      JSON.stringify({
        policy: 'user-access-authority-v1',
        principalUserId: input.principalUserId,
        sessionContract: input.sessionContract,
        sessionRevision: input.sessionRevision,
        userRevision: input.userRevision,
        memberships: [...input.memberships].sort((left, right) =>
          left.teamId.localeCompare(right.teamId)
        ),
        resource: resourceIdentityKey(input.resource),
        resourceRevision: input.resourceRevision,
        sourceStateRevision: input.sourceStateRevision,
        relationshipsRevision: input.relationshipsRevision,
        candidates: canonicalCandidates(input.candidates),
      })
    )
    .digest('base64url')}`
}

function canonicalValue(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
    .join(',')}}`
}

export function revisionOfValues(values: readonly unknown[]): string {
  return createHash('sha256')
    .update(`[${values.map(canonicalValue).sort().join(',')}]`)
    .digest('base64url')
}
