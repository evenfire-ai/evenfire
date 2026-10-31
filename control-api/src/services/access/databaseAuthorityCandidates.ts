import type { DbClient } from '../../db.js'
import { query } from './accessAuthorityQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import {
  type AuthorityCandidate,
  type OperationalPathBinding,
  authorityCandidate,
  authorityCandidateFromGrantRow,
} from './authorityCandidates.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import {
  type AccessCapability,
  capabilitiesForTeamRole,
  gfsPermissionsToCapabilities,
} from './capabilityRegistry.js'
import type { ValidatedOperationTarget } from './operationTarget.js'
import {
  type OperationalResourceGraphResult,
  loadOperationalResourceGraph,
  selectOperationalPathGraph,
} from './operationalAccessReader.js'
import { operationalBindingsForGraph } from './operationalAuthorityCandidates.js'
import type { PrincipalAuthoritySnapshot } from './principalAuthoritySnapshot.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'
import {
  assembleOperationalBehaviorDimensions,
  budgetContextRefsForGraph,
  loadRuntimeBehaviorPolicySnapshot,
} from './runtimeBehaviorSource.js'

export type ResourceAuthorityResult = Readonly<{
  exists: boolean
  candidates: readonly AuthorityCandidate[]
  relationships: readonly Readonly<{
    type: string
    targetResourceId: string
    instanceId?: string
  }>[]
  validUntil: Date | null
}>

function workflowRunResumeBindings(
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
): OperationalPathBinding[] {
  // Resume changes the exact durable run row. Its current recipe and Context are
  // exact-validated here; later MCP/provider/filesystem effects validate their
  // own selected targets at their existing protected-effect boundaries.
  return operationalBindingsForGraph(graph).filter(
    binding => binding.resourceType === 'workflow_recipe' || binding.resourceType === 'context'
  )
}

/**
 * The exact code points `String.prototype.trim` removes (ECMA-262 WhiteSpace
 * and LineTerminator), so `btrim(value, ...)` and `parseWorkflowTriggerIntent`
 * agree on what an absent or present approval requester is. `btrim`'s default
 * set only removes U+0020.
 */
const WORKFLOW_TRIGGER_TRIM_CODE_POINTS =
  '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005' +
  '\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

export async function loadDatabaseCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  snapshot: PrincipalAuthoritySnapshot
  resource: CanonicalResourceIdentity
  operationTarget?: ValidatedOperationTarget
}): Promise<ResourceAuthorityResult> {
  const { resource, snapshot } = input
  if (resource.type === 'user') {
    const owns = resource.logicalId === snapshot.userId
    return {
      exists: owns,
      candidates: owns
        ? [
            authorityCandidate({
              userId: snapshot.userId,
              kind: 'direct',
              grantId: `users:${snapshot.userId}`,
              capabilities: ['user.profile.read'],
            }),
          ]
        : [],
      relationships: [],
      validUntil: null,
    }
  }
  if (resource.type === 'team') {
    const membership = snapshot.memberships.find(value => value.teamId === resource.logicalId)
    return {
      exists: Boolean(membership),
      candidates: membership
        ? [
            authorityCandidate({
              userId: snapshot.userId,
              kind: 'team',
              grantId: `team_members:${membership.teamId}:${snapshot.userId}`,
              teamId: membership.teamId,
              currentRole: membership.role,
              capabilities: capabilitiesForTeamRole(membership.role),
            }),
          ]
        : [],
      relationships: membership
        ? [
            Object.freeze({
              type: 'membership',
              targetResourceId: `user:${snapshot.userId}`,
            }),
          ]
        : [],
      validUntil: null,
    }
  }

  const result = await query(
    input.db,
    input.budget,
    `WITH candidates AS (
       SELECT 'direct'::text AS kind, 'workflow_runs:user:' || wr.run_id AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role,
              NULL::text[] AS permissions, wr.recipe_namespace, wr.recipe_name,
              NULL::timestamptz AS valid_until, wr.team_id::text AS related_team,
              wr.usage_team_id AS usage_team, NULL::text AS drive,
              NULL::text AS parent_resource
         FROM workflow_runs wr
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = wr.recipe_namespace
          AND uwt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_run' AND wr.run_id::text = $3
          AND wr.actor_type = 'user' AND wr.actor_id = $1
          AND wr.team_id IS NULL AND wr.usage_team_id IS NULL
       UNION ALL
       SELECT 'team', 'workflow_runs:team:' || tm.team_id || ':' || wr.run_id,
              tm.team_id, tm.role, NULL, wr.recipe_namespace, wr.recipe_name,
              NULL, wr.team_id::text, wr.usage_team_id, NULL, NULL
         FROM workflow_runs wr
         JOIN team_members tm
           ON (tm.team_id = wr.team_id OR tm.team_id::text = wr.usage_team_id)
          AND tm.user_id = $1 AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = wr.recipe_namespace
          AND twt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_run' AND wr.run_id::text = $3
          AND (wr.actor_type IN ('scheduled', 'autonomous')
            OR (wr.actor_type = 'user' AND (wr.actor_id = $1 OR wr.actor_id IS NULL)))
       UNION ALL
       SELECT 'direct', 'workflow_artifacts:user:' || wr.run_id || ':' || $3,
              NULL, NULL, NULL, wr.recipe_namespace, wr.recipe_name,
              NULL, wr.team_id::text, wr.usage_team_id, NULL, NULL
         FROM workflow_runs wr
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = wr.recipe_namespace
          AND uwt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_artifact'
          AND wr.run_id::text = split_part($3, '/', 1)
          AND split_part($3, '/', 2) <> ''
          AND wr.actor_type = 'user' AND wr.actor_id = $1
          AND wr.team_id IS NULL AND wr.usage_team_id IS NULL
       UNION ALL
       SELECT 'team', 'workflow_artifacts:team:' || tm.team_id || ':' || $3,
              tm.team_id, tm.role, NULL, wr.recipe_namespace, wr.recipe_name,
              NULL, wr.team_id::text, wr.usage_team_id, NULL, NULL
         FROM workflow_runs wr
         JOIN team_members tm
           ON (tm.team_id = wr.team_id OR tm.team_id::text = wr.usage_team_id)
          AND tm.user_id = $1 AND tm.status = 'active'
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = wr.recipe_namespace
          AND twt.recipe_name = wr.recipe_name
        WHERE $2::text = 'workflow_artifact'
          AND wr.run_id::text = split_part($3, '/', 1)
          AND split_part($3, '/', 2) <> ''
       UNION ALL
       SELECT 'direct', 'workflow_approvals:user:' || war.id, NULL, NULL, NULL,
              war.recipe_namespace, war.recipe_name, war.expires_at, NULL, NULL, NULL, NULL
         FROM workflow_approval_requests war
         JOIN user_workflow_triggers uwt
           ON uwt.user_id = $1
          AND uwt.recipe_namespace = war.recipe_namespace
          AND uwt.recipe_name = war.recipe_name
        WHERE $2::text = 'workflow_approval' AND war.id::text = $3
          AND war.target_user_id = $1 AND war.status = 'pending' AND war.expires_at > NOW()
       UNION ALL
       SELECT 'team', 'workflow_approvals:team:' || tm.team_id || ':' || war.id,
              tm.team_id, tm.role, NULL, war.recipe_namespace, war.recipe_name,
              war.expires_at, war.target_team_id::text, NULL, NULL, NULL
         FROM workflow_approval_requests war
         JOIN team_members tm
           ON tm.team_id = war.target_team_id AND tm.user_id = $1 AND tm.status = 'active'
         JOIN workflow_recipe_allowed_teams wat
           ON wat.team_id = tm.team_id
          AND wat.recipe_namespace = war.recipe_namespace
          AND wat.recipe_name = war.recipe_name
        WHERE $2::text = 'workflow_approval' AND war.id::text = $3
          AND war.status = 'pending' AND war.expires_at > NOW()
          AND (
            jsonb_typeof(war.payload #> '{metadata,workflowTrigger,requesterUserId}')
              IS DISTINCT FROM 'string'
            OR btrim(
                 war.payload #>> '{metadata,workflowTrigger,requesterUserId}', $5::text
               ) IN ('', $1::text)
          )
       UNION ALL
       SELECT CASE WHEN g.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_grants:' || g.id,
              CASE WHEN g.subject_type = 'team' THEN tm.team_id ELSE NULL END,
              tm.role, g.permissions, NULL, NULL, NULL, NULL, NULL, g.drive,
              gr.parent_resource_id::text
         FROM gfs_grants g
         JOIN gfs_resources gr ON gr.resource_id = g.resource_id AND gr.deleted_at IS NULL
    LEFT JOIN team_members tm
           ON g.subject_type = 'team' AND tm.team_id::text = g.subject_id
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'gfs_resource' AND g.resource_id::text = $3
          AND ((g.subject_type = 'user' AND g.subject_id = $1::text)
            OR (g.subject_type = 'team' AND tm.team_id IS NOT NULL))
       UNION ALL
       SELECT CASE WHEN s.subject_type = 'user' THEN 'direct' ELSE 'team' END,
              'gfs_shares:' || s.id,
              CASE WHEN s.subject_type = 'team' THEN tm.team_id ELSE NULL END,
              tm.role, s.permissions, NULL, NULL, NULL, NULL, NULL, s.drive,
              gr.parent_resource_id::text
         FROM gfs_shares s
         JOIN gfs_resources gr ON gr.resource_id = s.resource_id AND gr.deleted_at IS NULL
    LEFT JOIN team_members tm
           ON s.subject_type = 'team' AND tm.team_id::text = s.subject_id
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'gfs_resource' AND s.resource_id::text = $3
          AND ((s.subject_type = 'user' AND s.subject_id = $1::text)
            OR (s.subject_type = 'team' AND tm.team_id IS NOT NULL))
       UNION ALL
       SELECT 'direct', 'notifications:user:' || nd.id, NULL, NULL, NULL,
              NULL, NULL, nd.expires_at, NULL, NULL, NULL, NULL
         FROM notification_deliveries nd
        WHERE $2::text = 'notification' AND nd.id::text = $3
          AND nd.audience->>'userId' = $1::text
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
       UNION ALL
       SELECT 'team', 'notifications:team:' || tm.team_id || ':' || nd.id,
              tm.team_id, tm.role, NULL, NULL, NULL, nd.expires_at,
              tm.team_id::text, NULL, NULL, NULL
         FROM notification_deliveries nd
         JOIN team_members tm
           ON tm.team_id::text = nd.audience->>'teamId'
          AND tm.user_id = $1 AND tm.status = 'active'
        WHERE $2::text = 'notification' AND nd.id::text = $3
          AND (nd.expires_at IS NULL OR nd.expires_at > NOW())
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id
     LIMIT $4`,
    [
      snapshot.userId,
      resource.type,
      resource.logicalId,
      input.budget.limits.accessPaths + 1,
      WORKFLOW_TRIGGER_TRIM_CODE_POINTS,
    ]
  )
  const rows = result.rows as Record<string, unknown>[]
  let workflowRunSource:
    | Readonly<{
        graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
        policySnapshot: Awaited<ReturnType<typeof loadRuntimeBehaviorPolicySnapshot>>
        runtimeRef: string
      }>
    | undefined
  if (
    resource.type === 'workflow_run' &&
    snapshot.sessionContract === 'v2' &&
    input.operationTarget?.runId === resource.logicalId &&
    input.operationTarget.action === 'resume'
  ) {
    const firstRun = rows[0]
    if (firstRun) {
      const recipeGraph = await loadOperationalResourceGraph({
        db: input.db,
        budget: input.budget,
        environmentId: resource.environmentId,
        resourceType: 'workflow_recipe',
        logicalId: `${String(firstRun.recipe_namespace)}/${String(firstRun.recipe_name)}`,
      })
      if (recipeGraph.status !== 'current') {
        throw new Error('workflow_resume_operational_graph_unavailable')
      }
      const selectedGraph = selectOperationalPathGraph({ graph: recipeGraph })
      if (!selectedGraph) throw new Error('workflow_resume_operational_graph_incomplete')
      const policySnapshot = await loadRuntimeBehaviorPolicySnapshot({
        db: input.db,
        budget: input.budget,
        contextRefs: budgetContextRefsForGraph(selectedGraph),
      })
      workflowRunSource = {
        graph: selectedGraph,
        policySnapshot,
        runtimeRef: JSON.stringify(
          selectedGraph.relationships
            .map(relationship => relationship.relationshipInstanceId)
            .sort(compareCanonicalUtf8Text)
        ),
      }
    }
  }
  const candidates = rows.flatMap(row => {
    const type = resource.type
    const capabilities: AccessCapability[] =
      type === 'workflow_run'
        ? [
            'workflow.read',
            'workflow.run.manage',
            'workflow.artifact.read',
            'workflow.artifact.delete',
          ]
        : type === 'workflow_artifact'
          ? ['workflow.artifact.read', 'workflow.artifact.delete']
          : type === 'workflow_approval'
            ? ['workflow.approval.decide']
            : type === 'gfs_resource'
              ? gfsPermissionsToCapabilities(row.permissions)
              : ['notification.read']
    const value = authorityCandidateFromGrantRow({
      row,
      userId: snapshot.userId,
      capabilities,
      runtimeSensitive: type === 'workflow_run' || type === 'workflow_artifact',
      approvalRef: type === 'workflow_approval' ? `approval:${resource.logicalId}` : undefined,
      filesystemScope:
        type === 'gfs_resource'
          ? JSON.stringify({ drive: row.drive, resourceId: resource.logicalId })
          : undefined,
      ...(type === 'workflow_run' && workflowRunSource
        ? {
            runtimeRef: workflowRunSource.runtimeRef,
            behaviorDimensions: assembleOperationalBehaviorDimensions({
              userId: snapshot.userId,
              ...(row.team_id ? { teamId: String(row.team_id) } : {}),
              graph: workflowRunSource.graph,
              policySnapshot: workflowRunSource.policySnapshot,
              runtimeRef: workflowRunSource.runtimeRef,
            }),
            operationalBindings: workflowRunResumeBindings(workflowRunSource.graph),
          }
        : {}),
    })
    return value ? [value] : []
  })
  const relationships: Array<{
    type: string
    targetResourceId: string
    instanceId?: string
  }> = []
  for (const row of rows) {
    if (
      resource.type === 'workflow_run' ||
      resource.type === 'workflow_artifact' ||
      resource.type === 'workflow_approval'
    ) {
      relationships.push(
        Object.freeze({
          type: 'recipe',
          targetResourceId: `workflow_recipe:${String(row.recipe_namespace)}/${String(row.recipe_name)}`,
        })
      )
      continue
    }
    if (resource.type === 'gfs_resource' && row.parent_resource) {
      relationships.push(
        Object.freeze({
          type: 'parent',
          targetResourceId: `gfs_resource:${String(row.parent_resource)}`,
        })
      )
      continue
    }
    if (resource.type === 'notification' && row.related_team) {
      relationships.push(
        Object.freeze({ type: 'team', targetResourceId: `team:${String(row.related_team)}` })
      )
    }
  }
  const validTimes = rows
    .map(row => (row.valid_until ? new Date(String(row.valid_until)) : null))
    .filter((value): value is Date => value !== null)
  return Object.freeze({
    exists: candidates.length > 0,
    candidates: Object.freeze(candidates),
    relationships: Object.freeze(relationships),
    validUntil:
      validTimes.length > 0
        ? new Date(Math.min(...validTimes.map(value => value.getTime())))
        : null,
  })
}
