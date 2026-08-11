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

export type AuthorizationRelationship = Readonly<{
  type: string
  targetResourceId: string
  instanceId?: string
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

export function canonicalAccessPathSeeds<T extends AccessPathSeed>(candidates: readonly T[]): T[] {
  const values = new Map<string, T>()
  for (const candidate of candidates) {
    values.set(
      JSON.stringify([
        candidate.kind,
        candidate.teamId ?? null,
        candidate.grantId,
        candidate.behavior,
      ]),
      candidate
    )
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

function canonicalCandidates(candidates: readonly AccessPathSeed[]) {
  return canonicalAccessPathSeeds(candidates).map(candidate => ({
    kind: candidate.kind,
    grantId: candidate.grantId,
    teamId: candidate.teamId ?? null,
    currentRole: candidate.currentRole ?? null,
    behavior: candidate.behavior,
  }))
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

export function canonicalAuthorizationRelationships(
  relationships: readonly AuthorizationRelationship[]
): AuthorizationRelationship[] {
  const values = new Map<string, AuthorizationRelationship>()
  for (const relationship of relationships) {
    values.set(
      JSON.stringify([
        relationship.type,
        relationship.targetResourceId,
        relationship.instanceId ?? null,
      ]),
      Object.freeze({ ...relationship })
    )
  }
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
}

export function databaseRelationshipsRevision(
  relationships: readonly AuthorizationRelationship[]
): string {
  return JSON.stringify(canonicalAuthorizationRelationships(relationships))
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
