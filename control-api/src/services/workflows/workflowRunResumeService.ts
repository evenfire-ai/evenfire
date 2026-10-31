import type { Pool } from 'pg'
import { type DbClient, pool, withTransaction } from '../../db.js'
import type { K8sGateway } from '../../k8s.js'
import { runAccessDatabaseQuery } from '../access/accessDatabaseQuery.js'
import { AccessExecutionBudget } from '../access/accessExecutionBudget.js'
import { type ActionAuthorizationV2Result, authorizeActionV2 } from '../access/actionAuthorizer.js'
import type { WorkflowRunRow } from '../workflowRunService.js'
import {
  type WorkflowAuthorityBinding,
  persistWorkflowAuthorityBinding,
} from './workflowAuthorityBindingService.js'

type LockedRun = {
  run_id: string
  recipe_namespace: string
  recipe_name: string
  phase: string
  actor_type: string
  actor_id: string | null
  team_id: string | null
  usage_team_id: string | null
  initiating_authority_binding_id: string | null
  initiating_user_id: string | null
  initiating_session_id: string | null
  initiating_session_version: number | null
  initiating_operation_id: string | null
  initiating_resource: Record<string, unknown> | null
  initiating_target: Record<string, unknown> | null
  initiating_path_kind: string | null
  initiating_effective_team_id: string | null
  initiating_source_is_current: boolean | null
  initiating_source_expires_at: string | null
  started_at: string | null
  child_recipe_name: string | null
}

export class WorkflowRunResumeError extends Error {
  constructor(
    readonly status: 403 | 404 | 409 | 503,
    readonly code:
      | 'workflow_run_not_found'
      | 'workflow_run_not_paused'
      | 'workflow_run_path_mismatch'
      | 'workflow_authority_unavailable'
  ) {
    super(code)
    this.name = 'WorkflowRunResumeError'
  }
}

const LOCK_RUN_FOR_RESUME = `
  SELECT run.run_id::text AS run_id,
         run.recipe_namespace,
         run.recipe_name,
         run.phase,
         run.actor_type,
         run.actor_id::text AS actor_id,
         run.team_id::text AS team_id,
         run.usage_team_id,
         run.initiating_authority_binding_id::text AS initiating_authority_binding_id,
         initiating.user_id::text AS initiating_user_id,
         initiating.session_id::text AS initiating_session_id,
         initiating.session_version AS initiating_session_version,
         initiating.operation_id AS initiating_operation_id,
         initiating.resource AS initiating_resource,
         initiating.target AS initiating_target,
         initiating.path_kind AS initiating_path_kind,
         initiating.effective_team_id::text AS initiating_effective_team_id,
         initiating.source_expires_at > clock_timestamp() AS initiating_source_is_current,
         initiating.source_expires_at::text AS initiating_source_expires_at,
         run.started_at,
         run.child_recipe_name
    FROM workflow_runs run
    LEFT JOIN workflow_authority_bindings initiating
      ON initiating.id = run.initiating_authority_binding_id
   WHERE run.run_id::text = $1
     AND run.recipe_namespace = $2
     AND run.recipe_name = $3
   FOR UPDATE OF run`

const RESUME_PAUSED_RUN = `
  UPDATE workflow_runs
     SET phase = CASE
           WHEN started_at IS NULL AND child_recipe_name IS NULL THEN 'Pending'
           ELSE 'Running'
         END,
         owner_instance_id = CASE
           WHEN started_at IS NULL AND child_recipe_name IS NULL THEN NULL
           ELSE owner_instance_id
         END,
         failure_reason = NULL,
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id::text = $1
     AND recipe_namespace = $2
     AND recipe_name = $3
     AND phase = 'AuthorizationPaused'
   RETURNING *`

function targetMatchesRecipe(
  target: Record<string, unknown> | null,
  recipeNamespace: string,
  recipeName: string
): boolean {
  return (
    target?.recipeNamespace === recipeNamespace &&
    target?.recipeName === recipeName &&
    Object.keys(target).length === 2
  )
}

function initiatingPathMatches(
  run: LockedRun,
  authority: WorkflowAuthorityBinding,
  runId: string,
  recipeNamespace: string,
  recipeName: string
): boolean {
  const binding = authority.binding
  if (
    run.actor_type !== 'user' ||
    run.actor_id !== binding.userId ||
    run.initiating_authority_binding_id === null ||
    run.initiating_operation_id !== 'workflow.trigger' ||
    run.initiating_user_id !== binding.userId ||
    run.initiating_session_id !== binding.sid ||
    run.initiating_session_version !== binding.sessionVersion ||
    run.initiating_path_kind !== binding.pathKind ||
    run.initiating_effective_team_id !== binding.effectiveTeamId ||
    run.initiating_resource?.type !== 'workflow_recipe' ||
    run.initiating_resource.logicalId !== `${recipeNamespace}/${recipeName}` ||
    !targetMatchesRecipe(run.initiating_target, recipeNamespace, recipeName) ||
    binding.operationId !== 'workflow.run.manage' ||
    binding.resource.type !== 'workflow_run' ||
    binding.resource.logicalId !== runId ||
    binding.target?.runId !== runId ||
    binding.target?.action !== 'resume' ||
    Object.keys(binding.target ?? {}).length !== 2
  ) {
    return false
  }

  if (binding.pathKind === 'direct') {
    return binding.effectiveTeamId === null && run.team_id === null && run.usage_team_id === null
  }
  return (
    binding.effectiveTeamId !== null &&
    run.team_id === binding.effectiveTeamId &&
    run.usage_team_id === binding.effectiveTeamId
  )
}

async function lockResumeAuthorityLineage(input: {
  db: DbClient
  budget: AccessExecutionBudget
  run: LockedRun
  authority: WorkflowAuthorityBinding
}): Promise<void> {
  const binding = input.authority.binding
  const session = await runAccessDatabaseQuery(
    input.db,
    input.budget,
    `SELECT user_row.id
       FROM users user_row
       JOIN external_user_sessions session
         ON session.user_id = user_row.id
      WHERE user_row.id = $1
        AND user_row.lifecycle_state = 'active'
        AND session.sid = $2
        AND session.session_version = $3
        AND session.revoked_at IS NULL
        AND session.idle_expires_at > clock_timestamp()
        AND session.absolute_expires_at > clock_timestamp()
      FOR SHARE OF user_row, session`,
    [binding.userId, binding.sid, binding.sessionVersion]
  )
  if (session.rows.length !== 1) {
    throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
  }

  const grant =
    binding.pathKind === 'direct'
      ? await runAccessDatabaseQuery(
          input.db,
          input.budget,
          `SELECT user_id
             FROM user_workflow_triggers
            WHERE user_id = $1
              AND recipe_namespace = $2
              AND recipe_name = $3
            FOR SHARE`,
          [binding.userId, input.run.recipe_namespace, input.run.recipe_name]
        )
      : await runAccessDatabaseQuery(
          input.db,
          input.budget,
          `SELECT twt.team_id
             FROM team_workflow_triggers twt
             JOIN team_members member
               ON member.team_id = twt.team_id
              AND member.user_id = $1
              AND member.status = 'active'
            WHERE twt.team_id = $2
              AND twt.recipe_namespace = $3
              AND twt.recipe_name = $4
            FOR SHARE OF twt, member`,
          [
            binding.userId,
            binding.effectiveTeamId,
            input.run.recipe_namespace,
            input.run.recipe_name,
          ]
        )
  if (grant.rows.length !== 1) {
    throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
  }
}

export async function resumeWorkflowRun(input: {
  runId: string
  recipeNamespace: string
  recipeName: string
  authority: WorkflowAuthorityBinding
  gateway: Pick<K8sGateway, 'getResourceExact'>
  db?: Pool
}): Promise<WorkflowRunRow> {
  const budget = AccessExecutionBudget.create('action')
  try {
    return await withTransaction(async db => {
      await runAccessDatabaseQuery(
        db,
        budget,
        `SELECT set_config('statement_timeout', $1, true)`,
        [`${budget.statementTimeoutMs()}ms`],
        { chargeRows: false, chargeProducer: false }
      )
      const selected = await runAccessDatabaseQuery(db, budget, LOCK_RUN_FOR_RESUME, [
        input.runId,
        input.recipeNamespace,
        input.recipeName,
      ])
      const run = selected.rows[0] as LockedRun | undefined
      if (!run) throw new WorkflowRunResumeError(404, 'workflow_run_not_found')
      if (run.phase !== 'AuthorizationPaused') {
        throw new WorkflowRunResumeError(409, 'workflow_run_not_paused')
      }
      if (run.initiating_source_is_current !== true) {
        throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
      }
      if (
        !initiatingPathMatches(
          run,
          input.authority,
          input.runId,
          input.recipeNamespace,
          input.recipeName
        )
      ) {
        throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
      }

      // Recheck the same selected path inside the run transaction. The row
      // locks below serialize grant/session revocation with this resume write.
      let currentAuthority: ActionAuthorizationV2Result
      try {
        currentAuthority = await authorizeActionV2(
          {
            session: Object.freeze({
              contract: 'v2',
              authorityMode: 'logical_session_checkpoint',
              userId: input.authority.binding.userId,
              sid: input.authority.binding.sid,
              sessionVersion: input.authority.binding.sessionVersion,
            }),
            requested: {
              version: 2,
              requestedAccessPathId: input.authority.binding.accessPathId,
              expectedAuthorizationRevision: input.authority.binding.authorizationRevision,
            },
            operationId: 'workflow.run.manage',
            resource: input.authority.binding.resource,
            operationTarget: input.authority.binding.target,
            allocateChatMessageId: false,
            budget,
            gateway: input.gateway,
          },
          {
            authorizationOptions: {
              transaction: async work => work(db as DbClient),
              configureTransaction: false,
            },
          }
        )
      } catch {
        throw new WorkflowRunResumeError(503, 'workflow_authority_unavailable')
      }
      if (
        currentAuthority.status !== 'allowed' ||
        currentAuthority.context.accessPathId !== input.authority.binding.accessPathId ||
        currentAuthority.context.authorizationRevision !==
          input.authority.binding.authorizationRevision ||
        currentAuthority.context.behaviorBindingHash !==
          input.authority.binding.behaviorBindingHash ||
        currentAuthority.context.targetHash !== input.authority.binding.targetHash ||
        currentAuthority.context.pathKind !== input.authority.binding.pathKind ||
        currentAuthority.context.effectiveTeamId !== input.authority.binding.effectiveTeamId
      ) {
        if (currentAuthority.status === 'authority_unavailable') {
          throw new WorkflowRunResumeError(503, 'workflow_authority_unavailable')
        }
        throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
      }
      await lockResumeAuthorityLineage({
        db: db as DbClient,
        budget,
        run,
        authority: input.authority,
      })

      if (!run.initiating_source_expires_at) {
        throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
      }
      const continuationBindingId = await persistWorkflowAuthorityBinding(db, {
        authority: input.authority,
        kind: 'run_management',
        entityType: 'workflow_run',
        entityId: input.runId,
      })
      const boundedExpiry = await db.query(
        `UPDATE workflow_authority_bindings
            SET source_expires_at = LEAST(source_expires_at, $2::timestamptz)
          WHERE id = $1
          RETURNING source_expires_at > clock_timestamp() AS current`,
        [continuationBindingId, run.initiating_source_expires_at]
      )
      if ((boundedExpiry.rows[0] as { current?: boolean } | undefined)?.current !== true) {
        throw new WorkflowRunResumeError(403, 'workflow_run_path_mismatch')
      }
      const resumed = await db.query(RESUME_PAUSED_RUN, [
        input.runId,
        input.recipeNamespace,
        input.recipeName,
      ])
      const row = resumed.rows[0] as WorkflowRunRow | undefined
      if (!row) throw new WorkflowRunResumeError(409, 'workflow_run_not_paused')
      return row
    }, input.db ?? pool)
  } finally {
    budget.close()
  }
}
