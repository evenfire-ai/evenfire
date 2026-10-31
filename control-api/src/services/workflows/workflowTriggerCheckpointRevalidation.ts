import {
  type ActionAuthorityCheckpointRequestV2,
  type ActionAuthorityCheckpointResponseV2,
  actionBehaviorBindingHash,
} from '@clerum/action-context-contracts'
import type { DbClient } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import type { ActionCheckpointCallerIdentity } from '../../middleware/actionCheckpointCaller.js'
import { runAccessDatabaseQuery } from '../access/accessDatabaseQuery.js'
import { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
import { type ActionAuthorizationV2Result, authorizeActionV2 } from '../access/actionAuthorizer.js'
import { resolveActionDestination } from '../access/actionDestination.js'
import { type LogicalSessionCheckpointAuthority } from '../access/principalAuthoritySnapshot.js'

type StoredWorkflowBinding = Readonly<{
  id: string
  binding_kind: 'trigger' | 'run_management'
  path_kind: 'direct' | 'team'
  effective_team_id: string | null
  recipe_namespace?: string
  recipe_name?: string
}>

type SelectedPath = Readonly<{
  id: string
  kind: 'direct' | 'team'
  teamId?: string
}>

function stale(currentAuthorizationRevision: string): ActionAuthorityCheckpointResponseV2 {
  return {
    version: 2,
    status: 'access_path_stale',
    code: 'access_path_stale',
    currentAuthorizationRevision,
  }
}

function invalidBinding(): ActionAuthorityCheckpointResponseV2 {
  return { version: 2, status: 'invalid_binding', code: 'invalid_binding' }
}

function unavailable(): ActionAuthorityCheckpointResponseV2 {
  return {
    version: 2,
    status: 'authority_unavailable',
    code: 'authority_unavailable',
    retryable: true,
  }
}

function sameStoredPath(
  candidate: Pick<SelectedPath, 'kind' | 'teamId'>,
  stored: StoredWorkflowBinding
): boolean {
  return (
    candidate.kind === stored.path_kind && (candidate.teamId ?? null) === stored.effective_team_id
  )
}

/**
 * Run creation and progress writes advance subject revisions after a workflow
 * binding is issued. Revalidate only an authenticated WRC checkpoint against
 * its exact persisted trigger or resume action and the same direct/team grant
 * lineage. The stored source expiry remains authoritative; this does not issue
 * or refresh a user credential.
 */
export async function revalidateWorkflowTriggerCheckpoint(input: {
  request: ActionAuthorityCheckpointRequestV2
  caller: ActionCheckpointCallerIdentity
  gateway: Pick<K8sGateway, 'getResourceExact'>
  budget: AccessExecutionBudget
  db: Pick<DbClient, 'query'>
  correlationId?: string
}): Promise<ActionAuthorityCheckpointResponseV2> {
  const { request, caller } = input
  const isTrigger =
    request.operationId === 'workflow.trigger' && request.resource.type === 'workflow_recipe'
  const isResume =
    request.operationId === 'workflow.run.manage' && request.resource.type === 'workflow_run'
  if (
    caller.service !== 'workflow-recipes' ||
    caller.trustPlane !== 'internal_control_jwt' ||
    (!isTrigger && !isResume)
  ) {
    return invalidBinding()
  }

  const target = request.target as Readonly<Record<string, unknown>>
  let recipeNamespace: string
  let recipeName: string
  let runId: string | null = null
  if (isTrigger) {
    recipeNamespace = String(target.recipeNamespace ?? '')
    recipeName = String(target.recipeName ?? '')
    if (
      !recipeNamespace ||
      !recipeName ||
      Object.keys(target).length !== 2 ||
      request.resource.logicalId !== `${recipeNamespace}/${recipeName}`
    ) {
      return invalidBinding()
    }
  } else {
    runId = String(target.runId ?? '')
    if (
      !runId ||
      target.action !== 'resume' ||
      Object.keys(target).length !== 2 ||
      request.resource.logicalId !== runId
    ) {
      return invalidBinding()
    }
    recipeNamespace = ''
    recipeName = ''
  }

  let storedRows: StoredWorkflowBinding[]
  try {
    const stored = isTrigger
      ? await runAccessDatabaseQuery(
          input.db,
          input.budget,
          `SELECT binding.id::text AS id,
              binding.binding_kind,
              binding.path_kind,
              binding.effective_team_id::text AS effective_team_id
         FROM workflow_authority_bindings binding
        WHERE binding.binding_kind = 'trigger'
          AND binding.entity_type = 'workflow_trigger'
          AND binding.delegation_jti = $1
          AND binding.user_id = $2
          AND binding.session_id = $3
          AND binding.session_version = $4
          AND binding.operation_id = 'workflow.trigger'
          AND binding.resource = $5::jsonb
          AND binding.target = $6::jsonb
          AND binding.target_hash = $7
          AND binding.access_path_id = $8
          AND binding.authorization_revision = $9
          AND binding.behavior_binding_hash = $10
          AND binding.source_expires_at > clock_timestamp()
          AND EXISTS (
            SELECT 1
              FROM workflow_runs run
             WHERE run.initiating_authority_binding_id = binding.id
               AND run.actor_type = 'user'
               AND run.actor_id = binding.user_id
               AND run.recipe_namespace = $11
               AND run.recipe_name = $12
               AND run.phase IN ('Pending', 'Running', 'AuthorizationPaused')
               AND (
                 (binding.path_kind = 'direct'
                   AND binding.effective_team_id IS NULL
                   AND run.team_id IS NULL
                   AND run.usage_team_id IS NULL)
                 OR
                 (binding.path_kind = 'team'
                   AND binding.effective_team_id IS NOT NULL
                   AND run.team_id = binding.effective_team_id
                   AND run.usage_team_id = binding.effective_team_id::text)
               )
          )
        LIMIT 2`,
          [
            request.delegationJti,
            request.principal.sub,
            request.principal.sid,
            request.principal.sessionVersion,
            JSON.stringify(request.resource),
            JSON.stringify(request.target),
            request.targetHash,
            request.accessPathId,
            request.authorizationRevision,
            request.behaviorBindingHash,
            recipeNamespace,
            recipeName,
          ]
        )
      : await runAccessDatabaseQuery(
          input.db,
          input.budget,
          `SELECT binding.id::text AS id,
                  binding.binding_kind,
                  binding.path_kind,
                  binding.effective_team_id::text AS effective_team_id,
                  run.recipe_namespace,
                  run.recipe_name
             FROM workflow_authority_bindings binding
             JOIN workflow_runs run
               ON run.run_id::text = binding.entity_id
             JOIN workflow_authority_bindings initiating
               ON initiating.id = run.initiating_authority_binding_id
            WHERE binding.binding_kind = 'run_management'
              AND binding.entity_type = 'workflow_run'
              AND binding.entity_id = $1
              AND binding.parent_binding_id IS NULL
              AND binding.transition_id IS NULL
              AND binding.delegation_jti = $2
              AND binding.user_id = $3
              AND binding.session_id = $4
              AND binding.session_version = $5
              AND binding.operation_id = 'workflow.run.manage'
              AND binding.resource = $6::jsonb
              AND binding.target = $7::jsonb
              AND binding.target_hash = $8
              AND binding.access_path_id = $9
              AND binding.authorization_revision = $10
              AND binding.behavior_binding_hash = $11
              AND binding.source_expires_at > clock_timestamp()
              AND run.actor_type = 'user'
              AND run.actor_id = binding.user_id
              AND run.phase IN ('Pending', 'Running', 'AuthorizationPaused')
              AND initiating.user_id = binding.user_id
              AND initiating.session_id = binding.session_id
              AND initiating.session_version = binding.session_version
              AND initiating.source_expires_at > clock_timestamp()
              AND initiating.path_kind = binding.path_kind
              AND initiating.effective_team_id IS NOT DISTINCT FROM binding.effective_team_id
              AND run.team_id IS NOT DISTINCT FROM binding.effective_team_id
              AND run.usage_team_id IS NOT DISTINCT FROM binding.effective_team_id::text
              AND initiating.resource->>'type' = 'workflow_recipe'
              AND initiating.resource->>'logicalId' =
                  run.recipe_namespace || '/' || run.recipe_name
              AND NOT EXISTS (
                SELECT 1
                  FROM workflow_authority_bindings newer
                 WHERE newer.binding_kind = 'run_management'
                   AND newer.entity_type = 'workflow_run'
                   AND newer.entity_id = binding.entity_id
                   AND (newer.created_at, newer.id) > (binding.created_at, binding.id)
              )
            LIMIT 2`,
          [
            runId,
            request.delegationJti,
            request.principal.sub,
            request.principal.sid,
            request.principal.sessionVersion,
            JSON.stringify(request.resource),
            JSON.stringify(request.target),
            request.targetHash,
            request.accessPathId,
            request.authorizationRevision,
            request.behaviorBindingHash,
          ]
        )
    storedRows = stored.rows as StoredWorkflowBinding[]
  } catch {
    return unavailable()
  }
  if (storedRows.length !== 1) return invalidBinding()
  const stored = storedRows[0]
  if (isResume) {
    recipeNamespace = stored.recipe_namespace ?? ''
    recipeName = stored.recipe_name ?? ''
    if (!recipeNamespace || !recipeName) return invalidBinding()
  }
  if (
    (stored.path_kind === 'direct' && stored.effective_team_id !== null) ||
    (stored.path_kind === 'team' && stored.effective_team_id === null)
  ) {
    return invalidBinding()
  }

  const session: LogicalSessionCheckpointAuthority = Object.freeze({
    contract: 'v2',
    authorityMode: 'logical_session_checkpoint',
    userId: request.principal.sub,
    sid: request.principal.sid,
    sessionVersion: request.principal.sessionVersion,
  })
  const resolveSelectedPath = (
    requestedAccessPathId?: string
  ): Promise<ActionAuthorizationV2Result> =>
    authorizeActionV2({
      session,
      requested: {
        version: 2,
        ...(requestedAccessPathId ? { requestedAccessPathId } : {}),
      },
      operationId: request.operationId,
      resource: request.resource as never,
      operationTarget: request.target,
      allocateChatMessageId: false,
      budget: input.budget,
      gateway: input.gateway,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
    })
  let selected: ActionAuthorizationV2Result
  try {
    selected = await resolveSelectedPath()
  } catch {
    return unavailable()
  }
  if (selected?.status === 'access_path_required') {
    const matches = selected.paths.filter(path => sameStoredPath(path, stored))
    if (matches.length !== 1) return { version: 2, status: 'denied', code: 'forbidden' }
    try {
      selected = await resolveSelectedPath(matches[0].id)
    } catch {
      return unavailable()
    }
  }
  if (selected?.status === 'authority_unavailable') return unavailable()
  if (selected?.status === 'access_path_stale') return stale(selected.currentAuthorizationRevision)
  if (selected?.status === 'denied') {
    return { version: 2, status: 'denied', code: 'forbidden' }
  }
  if (selected?.status === 'not_found') {
    return { version: 2, status: 'not_found', code: 'not_found' }
  }
  if (selected?.status !== 'allowed') {
    return { version: 2, status: 'invalid_binding', code: 'invalid_binding' }
  }
  const context = selected.context
  if (
    context.pathKind !== stored.path_kind ||
    context.effectiveTeamId !== stored.effective_team_id ||
    context.targetHash !== request.targetHash ||
    actionBehaviorBindingHash({
      accessPathId: request.accessPathId,
      authorizationRevision: request.authorizationRevision,
      behavior: context.behavior,
    }) !== request.behaviorBindingHash ||
    (context.validUntil !== null && Date.parse(context.validUntil) <= Date.now())
  ) {
    return stale(context.authorizationRevision)
  }
  let destination: Awaited<ReturnType<typeof resolveActionDestination>>
  try {
    destination = await resolveActionDestination({
      resource: context.resource,
      target: context.target,
      ...(selected.mcpServerBinding ? { mcpServerBinding: selected.mcpServerBinding } : {}),
      gateway: input.gateway,
      budget: input.budget,
    })
  } catch {
    return unavailable()
  }
  if (destination.status === 'stale') return stale(context.authorizationRevision)
  if (destination.status !== 'resolved') {
    return destination.status === 'unavailable'
      ? unavailable()
      : { version: 2, status: 'not_found', code: 'not_found' }
  }

  try {
    const stillCurrent = await runAccessDatabaseQuery(
      input.db,
      input.budget,
      `SELECT source_expires_at > clock_timestamp() AS current
         FROM workflow_authority_bindings
        WHERE id = $1`,
      [stored.id]
    )
    if ((stillCurrent.rows[0] as { current?: boolean } | undefined)?.current !== true) {
      return { version: 2, status: 'denied', code: 'forbidden' }
    }
  } catch {
    return unavailable()
  }

  // Revalidation proves the current policy still allows this exact operation,
  // target, session, and persisted grant lineage. The original revision and
  // behavior hash remain immutable provenance; neither is refreshed or issued.
  return Object.freeze({
    version: 2,
    status: 'allowed',
    authorizationRevision: request.authorizationRevision,
    behaviorBindingHash: request.behaviorBindingHash,
    behavior: Object.freeze({
      budget: context.behavior.budget,
      credentialPolicy: context.behavior.credentialPolicy,
      approvalPolicy: context.behavior.approvalPolicy,
      filesystemScope: context.behavior.filesystemScope,
      runtime: context.behavior.runtime,
      providerModelPolicy: context.behavior.providerModelPolicy,
      audit: context.behavior.audit,
    }),
    destination: destination.destination,
    checkedAt: new Date().toISOString(),
    validUntil: context.validUntil,
    attribution: Object.freeze({
      userId: context.principal.userId,
      sid: context.principal.sid,
      sessionVersion: context.principal.sessionVersion,
      accessPathId: request.accessPathId,
      pathKind: context.pathKind,
      effectiveTeamId: context.effectiveTeamId,
    }),
  })
}
