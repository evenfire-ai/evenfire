import type { DbClient } from '../../db.js'
import { query } from './accessAuthorityQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import type { AuthorityCandidate } from './authorityCandidates.js'
import type { AccessCapability } from './capabilityRegistry.js'
import {
  type ResourceAuthorityResult,
  loadDatabaseCandidates,
} from './databaseAuthorityCandidates.js'
import type { ValidatedOperationTarget } from './operationTarget.js'
import type { OperationalResourceGraphResult } from './operationalAccessReader.js'
import {
  loadDerivedOperationalCandidates,
  loadSimpleOperationalGrantCandidates,
} from './operationalAuthorityCandidates.js'
import type { PrincipalAuthoritySnapshot } from './principalAuthoritySnapshot.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'
import {
  assembleOperationalBehaviorDimensions,
  budgetContextRefsForGraph,
  loadRuntimeBehaviorPolicySnapshot,
} from './runtimeBehaviorSource.js'

function publicRelationships(graph: OperationalResourceGraphResult | null) {
  if (!graph || graph.status !== 'current') return []
  return graph.relationships.map(relationship =>
    Object.freeze({
      type: relationship.relationshipType,
      targetResourceId: `${relationship.targetType}:${relationship.targetId}`,
      instanceId: relationship.relationshipInstanceId,
    })
  )
}

export async function loadResourceAuthority(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  snapshot: PrincipalAuthoritySnapshot
  resource: CanonicalResourceIdentity
  operationTarget: ValidatedOperationTarget
  operationalGraph: OperationalResourceGraphResult | null
}): Promise<ResourceAuthorityResult> {
  if (input.resource.type === 'user' || input.resource.type === 'team') {
    return loadDatabaseCandidates(input)
  }
  if (input.operationalGraph?.status === 'current') {
    const policySnapshot = await loadRuntimeBehaviorPolicySnapshot({
      db: input.db,
      budget: input.budget,
      contextRefs: budgetContextRefsForGraph(input.operationalGraph),
    })
    const behaviorDimensions = (
      graph: Extract<OperationalResourceGraphResult, { status: 'current' }>,
      runtimeRef: string | null,
      teamId?: string
    ) =>
      assembleOperationalBehaviorDimensions({
        userId: input.snapshot.userId,
        ...(teamId ? { teamId } : {}),
        graph,
        policySnapshot,
        runtimeRef,
      })
    const candidates = ['mcp_server', 'shared_filesystem'].includes(input.resource.type)
      ? await loadDerivedOperationalCandidates({
          ...input,
          userId: input.snapshot.userId,
          behaviorDimensions,
          graph: input.operationalGraph,
        })
      : await loadSimpleOperationalGrantCandidates({
          ...input,
          userId: input.snapshot.userId,
          behaviorDimensions,
          graph: input.operationalGraph,
        })
    return Object.freeze({
      exists: candidates.length > 0,
      candidates: Object.freeze(candidates),
      relationships: Object.freeze(publicRelationships(input.operationalGraph)),
      validUntil: null,
    })
  }
  return loadDatabaseCandidates(input)
}

export async function operationTargetIsCurrentlyValid(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  resource: CanonicalResourceIdentity
  capability: AccessCapability
  operationTarget: ValidatedOperationTarget
}): Promise<boolean> {
  const target = input.operationTarget
  if (!target) return true
  if (target.teamId && target.teamId !== input.resource.logicalId) return false
  if (target.userId && ['team.member.read', 'team.member.manage'].includes(input.capability)) {
    const result = await query(
      input.db,
      input.budget,
      `SELECT 1 FROM team_members
        WHERE team_id = $1 AND user_id = $2 AND status = 'active'
        LIMIT 1`,
      [target.teamId, target.userId]
    )
    return (result.rowCount ?? 0) === 1
  }
  if (input.capability === 'team.member.invite' && target.action !== 'create') {
    const result = await query(
      input.db,
      input.budget,
      `SELECT 1
         FROM invitations invitation
         JOIN invitation_teams assignment ON assignment.invitation_id = invitation.id
        WHERE invitation.id = $1
          AND invitation.status = 'pending'
          AND assignment.team_id = $2
          AND assignment.role = $3
        LIMIT 1`,
      [target.invitationId, target.teamId, target.role]
    )
    return (result.rowCount ?? 0) === 1
  }
  return true
}

export function filterCandidatesForOperationTarget(input: {
  candidates: readonly AuthorityCandidate[]
  capability: AccessCapability
  operationTarget: ValidatedOperationTarget
}): AuthorityCandidate[] {
  const target = input.operationTarget
  if (!target) return [...input.candidates]
  let candidates = [...input.candidates]
  if (target.teamId) {
    candidates = candidates.filter(candidate => candidate.teamId === target.teamId)
  }
  if (
    target.role === 'admin' &&
    ['team.member.invite', 'team.member.manage'].includes(input.capability)
  ) {
    candidates = candidates.filter(candidate => candidate.currentRole === 'admin')
  }
  return candidates
}
