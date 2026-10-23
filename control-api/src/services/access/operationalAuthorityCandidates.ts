import type { DbClient } from '../../db.js'
import { query } from './accessAuthorityQuery.js'
import type { AccessExecutionBudget } from './accessExecutionBudget.js'
import {
  type AuthorityCandidate,
  type OperationalPathBinding,
  authorityCandidateFromGrantRow,
} from './authorityCandidates.js'
import { compareCanonicalUtf8Text } from './canonicalText.js'
import type { AccessCapability } from './capabilityRegistry.js'
import { canonicalContextLogicalIdSql } from './contextIdentitySql.js'
import {
  type OperationalResourceGraphResult,
  selectOperationalPathGraph,
} from './operationalAccessReader.js'
import type { CanonicalResourceIdentity } from './resourceIdentity.js'
import { assembleOperationalBehaviorDimensions } from './runtimeBehaviorSource.js'
import { workflowTriggerGrantIdentitySql } from './workflowTriggerGrantIdentity.js'

function scopedName(logicalId: string): { namespace: string; name: string } | null {
  const separator = logicalId.indexOf('/')
  if (separator < 1 || separator === logicalId.length - 1) return null
  return { namespace: logicalId.slice(0, separator), name: logicalId.slice(separator + 1) }
}

export function operationalBindingsForGraph(
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
): OperationalPathBinding[] {
  const supported = new Set([
    'host',
    'context',
    'mcp_server',
    'workflow_recipe',
    'shared_filesystem',
  ])
  return graph.resources
    .filter(resource => supported.has(resource.resourceType))
    .map(resource => ({
      resourceType: resource.resourceType as OperationalPathBinding['resourceType'],
      logicalId: resource.logicalId,
      providerUid: resource.providerUid,
      providerResourceVersion: resource.providerResourceVersion,
      behaviorSources: resource.behaviorSources,
      relationships: graph.relationships
        .filter(
          relationship =>
            relationship.sourceType === resource.resourceType &&
            relationship.sourceId === resource.logicalId
        )
        .map(relationship => ({
          instanceId: relationship.relationshipInstanceId,
          behaviorAttributes: relationship.behaviorAttributes,
        })),
    }))
}

export async function loadSimpleOperationalGrantCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  userId: string
  behaviorDimensions: (
    graph: Extract<OperationalResourceGraphResult, { status: 'current' }>,
    runtimeRef: string | null,
    teamId?: string
  ) => ReturnType<typeof assembleOperationalBehaviorDimensions>
  resource: CanonicalResourceIdentity
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
}): Promise<AuthorityCandidate[]> {
  const identity = scopedName(input.resource.logicalId)
  if (!identity) return []
  const isHost = input.resource.type === 'host'
  const isContext = input.resource.type === 'context'
  const isRecipe = ['workflow_recipe', 'sandbox_app'].includes(input.resource.type)
  if (!isHost && !isContext && !isRecipe) return []
  const directWorkflowTriggerGrantId = workflowTriggerGrantIdentitySql('direct', 'uwt')
  const teamWorkflowTriggerGrantId = workflowTriggerGrantIdentitySql('team', 'twt')
  const result = await query(
    input.db,
    input.budget,
    `WITH requested_context_references AS (
       SELECT $5::text AS logical_id, split_part($5::text, '/', 2) AS reference_name
       UNION
       SELECT alias_relationship.source_id,
              split_part(alias_relationship.target_id, '/', 2)
         FROM operational_resource_relationships alias_relationship
         JOIN operational_resource_index alias_source
           ON alias_source.environment_id = alias_relationship.environment_id
          AND alias_source.resource_type = 'context'
          AND alias_source.logical_id = alias_relationship.source_id
          AND alias_source.provider_uid = alias_relationship.source_provider_uid
        WHERE alias_relationship.environment_id = $6
          AND alias_relationship.source_type = 'context'
          AND alias_relationship.source_id = $5
          AND alias_relationship.relationship_type = 'context_identity_alias'
          AND alias_relationship.target_type = 'context'
     ), candidates AS (
       SELECT 'direct'::text AS kind,
              'user_agents:' || ua.user_id || ':' || ua.agent_name AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role
         FROM user_agents ua
        WHERE $2::text = 'host' AND ua.user_id = $1 AND ua.agent_name = $4
       UNION ALL
       SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
              ta.team_id, tm.role
         FROM team_agents ta
         JOIN team_members tm ON tm.team_id = ta.team_id
        WHERE $2::text = 'host' AND tm.user_id = $1 AND tm.status = 'active'
          AND ta.agent_name = $4
       UNION ALL
       SELECT 'direct', 'user_contexts:' || uc.user_id || ':' || uc.context_id,
              NULL, NULL
         FROM user_contexts uc
         JOIN requested_context_references requested
           ON requested.reference_name = uc.context_id
        WHERE $2::text = 'context' AND uc.user_id = $1
          AND ${canonicalContextLogicalIdSql('$6', "split_part(requested.logical_id, '/', 1) || '/' || uc.context_id")} = requested.logical_id
       UNION ALL
       SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
              tc.team_id, tm.role
         FROM team_contexts tc
         JOIN requested_context_references requested
           ON requested.reference_name = tc.context_id
         JOIN team_members tm ON tm.team_id = tc.team_id
        WHERE $2::text = 'context' AND tm.user_id = $1 AND tm.status = 'active'
          AND ${canonicalContextLogicalIdSql('$6', "split_part(requested.logical_id, '/', 1) || '/' || tc.context_id")} = requested.logical_id
       UNION ALL
       SELECT 'direct', ${directWorkflowTriggerGrantId},
              NULL, NULL
         FROM user_workflow_triggers uwt
        WHERE $2::text IN ('workflow_recipe','sandbox_app') AND uwt.user_id = $1
          AND uwt.recipe_namespace = $3 AND uwt.recipe_name = $4
       UNION ALL
       SELECT 'team', ${teamWorkflowTriggerGrantId},
              twt.team_id, tm.role
         FROM team_workflow_triggers twt
         JOIN team_members tm ON tm.team_id = twt.team_id
        WHERE $2::text IN ('workflow_recipe','sandbox_app')
          AND tm.user_id = $1 AND tm.status = 'active'
          AND twt.recipe_namespace = $3 AND twt.recipe_name = $4
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id
     LIMIT $7`,
    [
      input.userId,
      input.resource.type,
      identity.namespace,
      identity.name,
      input.resource.logicalId,
      input.graph.resource.environmentId,
      input.budget.limits.accessPaths + 1,
    ]
  )
  const capabilities: AccessCapability[] = isHost
    ? [
        'host.read',
        'host.use',
        'host.activity.read',
        'remote_desktop.use',
        'chat.read',
        'chat.message.invoke',
        'task.read',
        'task.manage',
        'model.read',
        'model.select',
        'session.read',
        'session.manage',
      ]
    : isContext
      ? ['context.read', 'context.use']
      : input.resource.type === 'sandbox_app'
        ? ['sandbox_app.read', 'sandbox_app.use', 'sandbox_oauth.vend']
        : ['workflow.read', 'workflow.trigger']
  const selectedGraph = selectOperationalPathGraph({ graph: input.graph })
  if (!selectedGraph) return []
  const runtimeRef = JSON.stringify(
    selectedGraph.relationships
      .map(relationship => relationship.relationshipInstanceId)
      .sort(compareCanonicalUtf8Text)
  )
  return (result.rows as Record<string, unknown>[]).flatMap(row => {
    const value = authorityCandidateFromGrantRow({
      row,
      userId: input.userId,
      capabilities,
      runtimeSensitive: true,
      runtimeRef,
      behaviorDimensions: input.behaviorDimensions(
        selectedGraph,
        runtimeRef,
        row.team_id ? String(row.team_id) : undefined
      ),
      operationalBindings: operationalBindingsForGraph(selectedGraph),
    })
    return value ? [value] : []
  })
}

export async function loadDerivedOperationalCandidates(input: {
  db: Pick<DbClient, 'query'>
  budget: AccessExecutionBudget
  userId: string
  behaviorDimensions: (
    graph: Extract<OperationalResourceGraphResult, { status: 'current' }>,
    runtimeRef: string | null,
    teamId?: string
  ) => ReturnType<typeof assembleOperationalBehaviorDimensions>
  resource: CanonicalResourceIdentity
  graph: Extract<OperationalResourceGraphResult, { status: 'current' }>
}): Promise<AuthorityCandidate[]> {
  if (input.resource.type !== 'mcp_server' && input.resource.type !== 'shared_filesystem') {
    return []
  }
  const directEdges = input.graph.relationships.filter(relationship => {
    if (input.resource.type === 'mcp_server') {
      return (
        relationship.relationshipType === 'includes_mcp_server' &&
        relationship.targetId === input.resource.logicalId
      )
    }
    return (
      relationship.relationshipType === 'mounts_shared_filesystem' &&
      relationship.targetId === input.resource.logicalId
    )
  })
  const contextIds = [...new Set(directEdges.map(edge => edge.sourceId))]
  const hostEdges =
    input.resource.type === 'mcp_server'
      ? input.graph.relationships.filter(
          relationship =>
            relationship.relationshipType === 'uses_context' &&
            relationship.targetType === 'context' &&
            contextIds.includes(relationship.targetId)
        )
      : []
  const hostIds = [...new Set(hostEdges.map(edge => edge.sourceId))]
  const hostNames = hostIds.map(value => scopedName(value)?.name ?? '').filter(Boolean)
  if (contextIds.length === 0 && hostNames.length === 0) return []
  const result = await query(
    input.db,
    input.budget,
    `WITH context_names AS (SELECT UNNEST($2::text[]) AS logical_id),
          context_references AS MATERIALIZED (
       SELECT requested.logical_id,
              split_part(requested.logical_id, '/', 2) AS reference_name
         FROM context_names requested
       UNION
       SELECT requested.logical_id,
              split_part(alias_relationship.target_id, '/', 2)
         FROM context_names requested
         JOIN operational_resource_relationships alias_relationship
           ON alias_relationship.environment_id = $4
          AND alias_relationship.source_type = 'context'
          AND alias_relationship.source_id = requested.logical_id
          AND alias_relationship.relationship_type = 'context_identity_alias'
          AND alias_relationship.target_type = 'context'
         JOIN operational_resource_index alias_source
           ON alias_source.environment_id = alias_relationship.environment_id
          AND alias_source.resource_type = 'context'
          AND alias_source.logical_id = alias_relationship.source_id
          AND alias_source.provider_uid = alias_relationship.source_provider_uid
     ),
          host_names AS (SELECT UNNEST($3::text[]) AS name),
          candidates AS (
       SELECT 'direct'::text AS kind,
              'user_contexts:' || uc.user_id || ':' || uc.context_id AS grant_id,
              NULL::uuid AS team_id, NULL::text AS current_role,
              'context'::text AS source_type, context_identity.canonical_id AS source_name
        FROM user_contexts uc
        JOIN context_references requested ON requested.reference_name = uc.context_id
        CROSS JOIN LATERAL (
          SELECT ${canonicalContextLogicalIdSql('$4', "split_part(requested.logical_id, '/', 1) || '/' || uc.context_id")}
                   AS canonical_id
        ) context_identity
        WHERE uc.user_id = $1 AND context_identity.canonical_id = requested.logical_id
       UNION ALL
       SELECT 'team', 'team_contexts:' || tc.team_id || ':' || tc.context_id,
              tc.team_id, tm.role, 'context', context_identity.canonical_id
         FROM team_contexts tc
         JOIN context_references requested ON requested.reference_name = tc.context_id
         CROSS JOIN LATERAL (
           SELECT ${canonicalContextLogicalIdSql('$4', "split_part(requested.logical_id, '/', 1) || '/' || tc.context_id")}
                    AS canonical_id
         ) context_identity
         JOIN team_members tm ON tm.team_id = tc.team_id
        WHERE tm.user_id = $1 AND tm.status = 'active'
          AND context_identity.canonical_id = requested.logical_id
       UNION ALL
       SELECT 'direct', 'user_agents:' || ua.user_id || ':' || ua.agent_name,
              NULL, NULL, 'host', ua.agent_name
         FROM user_agents ua JOIN host_names requested ON requested.name = ua.agent_name
        WHERE ua.user_id = $1
       UNION ALL
       SELECT 'team', 'team_agents:' || ta.team_id || ':' || ta.agent_name,
              ta.team_id, tm.role, 'host', ta.agent_name
         FROM team_agents ta JOIN host_names requested ON requested.name = ta.agent_name
         JOIN team_members tm ON tm.team_id = ta.team_id
        WHERE tm.user_id = $1 AND tm.status = 'active'
     )
     SELECT * FROM candidates
     ORDER BY kind, team_id NULLS FIRST, grant_id, source_type, source_name
     LIMIT $5`,
    [
      input.userId,
      contextIds,
      hostNames,
      input.graph.resource.environmentId,
      input.budget.limits.accessPaths + 1,
    ]
  )
  const output: AuthorityCandidate[] = []
  for (const row of result.rows as Record<string, unknown>[]) {
    const sourceType = String(row.source_type)
    const sourceName = String(row.source_name)
    if (sourceType === 'context') {
      const contextId = contextIds.find(value => value === sourceName)
      if (!contextId) continue
      for (const edge of directEdges.filter(value => value.sourceId === contextId)) {
        const selectedGraph = selectOperationalPathGraph({
          graph: input.graph,
          contextId,
        })
        if (!selectedGraph) continue
        const filesystemScope =
          input.resource.type === 'shared_filesystem'
            ? JSON.stringify({
                contextId,
                relationshipInstanceId: edge.relationshipInstanceId,
                mountPath: edge.behaviorAttributes.mountPath,
                readOnly: true,
              })
            : undefined
        const value = authorityCandidateFromGrantRow({
          row: {
            ...row,
            grant_id: `${String(row.grant_id)}:${edge.relationshipInstanceId}`,
          },
          userId: input.userId,
          capabilities:
            input.resource.type === 'mcp_server'
              ? ['mcp_server.read', 'mcp_server.use']
              : ['shared_filesystem.read'],
          runtimeSensitive: input.resource.type === 'mcp_server',
          runtimeRef: edge.relationshipInstanceId,
          behaviorDimensions: input.behaviorDimensions(
            selectedGraph,
            edge.relationshipInstanceId,
            row.team_id ? String(row.team_id) : undefined
          ),
          filesystemScope,
          operationalBindings: operationalBindingsForGraph(selectedGraph),
        })
        if (value) output.push(value)
      }
      continue
    }
    const hostId = hostIds.find(value => scopedName(value)?.name === sourceName)
    if (!hostId) continue
    for (const hostEdge of hostEdges.filter(value => value.sourceId === hostId)) {
      const contextEdge = directEdges.find(value => value.sourceId === hostEdge.targetId)
      if (!contextEdge) continue
      const selectedGraph = selectOperationalPathGraph({
        graph: input.graph,
        contextId: hostEdge.targetId,
        hostId,
      })
      if (!selectedGraph) continue
      const value = authorityCandidateFromGrantRow({
        row: {
          ...row,
          grant_id: `${String(row.grant_id)}:${hostEdge.relationshipInstanceId}:${contextEdge.relationshipInstanceId}`,
        },
        userId: input.userId,
        capabilities: ['mcp_server.read', 'mcp_server.use'],
        runtimeSensitive: true,
        runtimeRef: JSON.stringify([
          hostEdge.relationshipInstanceId,
          contextEdge.relationshipInstanceId,
        ]),
        behaviorDimensions: input.behaviorDimensions(
          selectedGraph,
          JSON.stringify([hostEdge.relationshipInstanceId, contextEdge.relationshipInstanceId]),
          row.team_id ? String(row.team_id) : undefined
        ),
        operationalBindings: operationalBindingsForGraph(selectedGraph),
      })
      if (value) output.push(value)
    }
  }
  return output
}
