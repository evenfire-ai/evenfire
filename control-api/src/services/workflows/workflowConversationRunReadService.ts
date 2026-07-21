import { type DbClient, pool } from '../../db.js'
import { getMcpHostCallerKey } from '../../utils/auth/mcpHostJwtToken.js'
import type { WorkflowRunRow } from '../workflowRunService.js'
import type { WorkflowRouteCaller } from './types.js'
import type { WorkflowApprovalTarget } from './workflowRecipeAccessService.js'

export type ConversationScopedWorkflowHealth = {
  activeRuns: number
  lastRun: WorkflowRunRow | null
}

/**
 * Reads run health through the same approval target, trigger caller, and
 * conversation boundary used by authenticated workflow artifact reads.
 */
export async function getConversationScopedWorkflowHealth(params: {
  caller: Extract<WorkflowRouteCaller, { kind: 'mcp-host-control' }>
  recipeNamespace: string
  recipeName: string
  approvalTarget: WorkflowApprovalTarget
  conversationId: string
  db?: DbClient
}): Promise<ConversationScopedWorkflowHealth> {
  const { caller, recipeNamespace, recipeName, approvalTarget, conversationId, db = pool } = params
  const callerKey = getMcpHostCallerKey(caller.claims)
  const result = await db.query(
    `WITH scoped_runs AS (
       SELECT wr.*
         FROM workflow_runs wr
         JOIN workflow_approval_requests war
           ON war.id = wr.approval_request_id
         JOIN workflow_approval_trigger_intents wati
           ON wati.approval_request_id = war.id
        WHERE (
            (wr.recipe_namespace = $1 AND wr.recipe_name = $2)
            OR (wr.child_recipe_namespace = $1 AND wr.child_recipe_name = $2)
          )
          AND (
            ($3::uuid IS NOT NULL AND war.target_user_id = $3::uuid)
            OR ($4::uuid IS NOT NULL AND war.target_team_id = $4::uuid)
          )
          AND wati.trigger_namespace = wr.recipe_namespace
          AND wati.trigger_name = wr.recipe_name
          AND wati.trigger_caller_key = $5
          AND war.payload->'metadata'->'workflowTrigger'->>'conversationId' = $6
     )
     SELECT scoped_runs.*,
            (COUNT(*) FILTER (
              WHERE scoped_runs.phase IN ('Pending', 'Running')
            ) OVER ())::int AS "activeRuns"
       FROM scoped_runs
      ORDER BY scoped_runs.created_at DESC,
               scoped_runs.started_at DESC NULLS LAST
      LIMIT 1`,
    [
      recipeNamespace,
      recipeName,
      approvalTarget.targetUserId ?? null,
      approvalTarget.targetTeamId ?? null,
      callerKey,
      conversationId,
    ]
  )

  const row = result.rows[0] as (WorkflowRunRow & { activeRuns: number }) | undefined
  return row ? { activeRuns: row.activeRuns, lastRun: row } : { activeRuns: 0, lastRun: null }
}
