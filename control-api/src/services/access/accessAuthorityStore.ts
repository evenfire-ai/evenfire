import type { DbClient } from '../../db.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
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
