import { type DbClient, pool } from '../../db.js'

export type WorkflowTriggerGrantMode =
  | 'direct-user-session'
  | 'approval-target-user'
  | 'approval-target-team'

export type WorkflowTriggerGrantResult =
  | { granted: false }
  | { granted: true; source: 'user'; userId: string }
  | { granted: true; source: 'team'; teamId: string }

export type ListApprovalTargetWorkflowTriggerKeysParams =
  | { mode: 'approval-target-user'; userId: string }
  | { mode: 'approval-target-team'; targetTeamId: string }

type WorkflowTriggerGrantBaseParams = {
  userId: string
  recipeNamespace: string
  recipeName: string
}

export type ResolveWorkflowTriggerGrantParams =
  | (WorkflowTriggerGrantBaseParams & {
      mode: 'direct-user-session'
      currentTeamId?: string | null
      targetTeamId?: never
    })
  | (WorkflowTriggerGrantBaseParams & {
      mode: 'approval-target-user'
      currentTeamId?: never
      targetTeamId?: never
    })
  | (WorkflowTriggerGrantBaseParams & {
      mode: 'approval-target-team'
      currentTeamId?: never
      targetTeamId?: string | null
    })

function workflowKeyRows(rows: unknown[]): Set<string> {
  return new Set(
    (rows as Array<{ recipe_namespace?: unknown; recipe_name?: unknown }>).flatMap(row => {
      const namespace = String(row.recipe_namespace || '')
      const name = String(row.recipe_name || '')
      return namespace && name ? [`${namespace}/${name}`] : []
    })
  )
}

export async function resolveWorkflowTriggerGrant(
  params: ResolveWorkflowTriggerGrantParams,
  db: DbClient = pool
): Promise<WorkflowTriggerGrantResult> {
  if (params.mode === 'approval-target-team') {
    const targetTeamId = params.targetTeamId?.trim()
    if (!targetTeamId) return { granted: false }

    const teamContext = await db.query(
      `SELECT (twt.team_id IS NOT NULL) AS "teamGranted"
         FROM team_members tm
         LEFT JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = $3
          AND twt.recipe_name = $4
        WHERE tm.user_id = $1
          AND tm.team_id = $2
          AND tm.status = 'active'`,
      [params.userId, targetTeamId, params.recipeNamespace, params.recipeName]
    )
    if ((teamContext.rowCount ?? 0) === 0) return { granted: false }

    const row = teamContext.rows[0] as { teamGranted?: boolean } | undefined
    return row?.teamGranted === true
      ? { granted: true, source: 'team', teamId: targetTeamId }
      : { granted: false }
  }

  const direct = await db.query(
    `SELECT 1 FROM user_workflow_triggers
      WHERE user_id = $1 AND recipe_namespace = $2 AND recipe_name = $3`,
    [params.userId, params.recipeNamespace, params.recipeName]
  )

  if (params.mode === 'approval-target-user') {
    return (direct.rowCount ?? 0) > 0
      ? { granted: true, source: 'user', userId: params.userId }
      : { granted: false }
  }

  if (params.mode === 'direct-user-session') {
    if ((direct.rowCount ?? 0) > 0) {
      return { granted: true, source: 'user', userId: params.userId }
    }

    const currentTeamId = params.currentTeamId?.trim()
    if (!currentTeamId) return { granted: false }

    const team = await db.query(
      `SELECT 1
         FROM team_members tm
         JOIN team_workflow_triggers twt
           ON twt.team_id = tm.team_id
          AND twt.recipe_namespace = $3
          AND twt.recipe_name = $4
        WHERE tm.user_id = $1
          AND tm.team_id = $2
          AND tm.status = 'active'`,
      [params.userId, currentTeamId, params.recipeNamespace, params.recipeName]
    )
    return (team.rowCount ?? 0) > 0
      ? { granted: true, source: 'team', teamId: currentTeamId }
      : { granted: false }
  }

  const _exhaustive: never = params
  throw new Error('Unhandled workflow trigger grant mode')
}

export async function listApprovalTargetWorkflowTriggerKeys(
  params: ListApprovalTargetWorkflowTriggerKeysParams,
  db: DbClient = pool
): Promise<Set<string>> {
  if (params.mode === 'approval-target-user') {
    const result = await db.query(
      `SELECT recipe_namespace, recipe_name
         FROM user_workflow_triggers
        WHERE user_id = $1`,
      [params.userId]
    )
    return workflowKeyRows(result.rows)
  }

  const result = await db.query(
    `SELECT wat.recipe_namespace, wat.recipe_name
       FROM workflow_recipe_allowed_teams wat
       JOIN team_workflow_triggers twt
         ON twt.team_id = wat.team_id
        AND twt.recipe_namespace = wat.recipe_namespace
        AND twt.recipe_name = wat.recipe_name
      WHERE wat.team_id = $1`,
    [params.targetTeamId]
  )
  return workflowKeyRows(result.rows)
}
