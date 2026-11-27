import { pool } from '../../db.js'
import type { DbClient } from '../../db.js'
import { getMcpHostCallerKey } from '../../utils/auth/mcpHostJwtToken.js'
import type { WorkflowRunRow } from '../workflowRunService.js'
import { listRunsByRecipe } from '../workflowRunService.js'
import type {
  CanonicalRunActor,
  CanonicalRunDto,
  CanonicalRunExecutionRef,
  WorkflowRouteCaller,
} from './types.js'
import { getWorkflowPrincipalId } from './workflowCallerService.js'
import {
  type WorkflowApprovalTarget,
  isMcpHostDirectlyAuthorizedForRecipe,
} from './workflowRecipeAccessService.js'

export type UserRunScope = {
  userId: string
  principalIds: readonly string[]
  teamId: string | null
}

export type ApprovalScopedWorkflowRunRow = WorkflowRunRow & {
  approval_target_user_id?: string | null
  approval_target_team_id?: string | null
  approval_target_team_member_user_id?: string | null
}

export type ProviderScopedWorkflowRunRow = WorkflowRunRow & {
  approval_target_user_id: string | null
  approval_target_team_id: string | null
}

export function userRunScope(caller: WorkflowRouteCaller): UserRunScope | null {
  if (caller.kind !== 'user-session') return null
  const ids = new Set([caller.claims.userId, getWorkflowPrincipalId(caller)])
  return {
    userId: caller.claims.userId,
    principalIds: [...ids],
    teamId: caller.claims.teamId?.trim() || null,
  }
}

/**
 * The scope team's live grant on a recipe, reached through the scope user's
 * active membership of that team. Parameters: $1 scope user id, $2 scope team
 * id, $3 recipe namespace, $4 recipe name.
 */
const LIVE_SCOPE_TEAM_RECIPE_GRANT_ROWS = `
       FROM team_members tm
       JOIN team_workflow_triggers twt
         ON twt.team_id = tm.team_id
        AND twt.recipe_namespace = $3
        AND twt.recipe_name = $4
      WHERE tm.user_id = $1
        AND tm.team_id = $2
        AND tm.status = 'active'`

/**
 * A live admin of the scope team whose team holds a live grant on the recipe:
 * the grant predicate of `hasLiveWorkflowTeamGrant` plus the admin role.
 * Same parameters as `LIVE_SCOPE_TEAM_RECIPE_GRANT_ROWS`.
 */
export const LIVE_SCOPE_TEAM_ADMIN_WITH_RECIPE_GRANT = `
     SELECT 1${LIVE_SCOPE_TEAM_RECIPE_GRANT_ROWS}
        AND tm.role = 'admin'`

async function hasLiveWorkflowTeamGrant(
  scope: UserRunScope,
  recipeNamespace: string,
  recipeName: string,
  db: Pick<DbClient, 'query'> = pool
): Promise<boolean> {
  if (!scope.teamId) return false
  const result = await db.query(`SELECT 1${LIVE_SCOPE_TEAM_RECIPE_GRANT_ROWS}\n      LIMIT 1`, [
    scope.userId,
    scope.teamId,
    recipeNamespace,
    recipeName,
  ])
  return (result.rowCount ?? 0) > 0
}

function isTeamScopedRun(row: Pick<WorkflowRunRow, 'actor_type'>): boolean {
  return row.actor_type === 'scheduled' || row.actor_type === 'autonomous'
}

function approvalTargetMatchesUserScope(
  row: ApprovalScopedWorkflowRunRow,
  scope: UserRunScope
): boolean {
  if (!row.approval_request_id) return false
  if (row.approval_target_user_id && scope.principalIds.includes(row.approval_target_user_id)) {
    return true
  }
  return (
    row.approval_target_team_id === scope.teamId &&
    row.approval_target_team_member_user_id === scope.userId
  )
}

function runMatchesScopeTeam(
  row: Pick<WorkflowRunRow, 'team_id' | 'usage_team_id'>,
  scope: UserRunScope
): boolean {
  return (
    Boolean(scope.teamId) && (row.team_id === scope.teamId || row.usage_team_id === scope.teamId)
  )
}

function isRunLauncher(
  row: Pick<WorkflowRunRow, 'actor_type' | 'actor_id'>,
  scope: UserRunScope
): boolean {
  if (row.actor_type !== 'user' || !row.actor_id) return false
  return scope.principalIds.includes(row.actor_id)
}

export function runMatchesUserScope(
  row: ApprovalScopedWorkflowRunRow,
  scope: UserRunScope
): boolean {
  const matchesTeam = runMatchesScopeTeam(row, scope)
  if (row.actor_type === 'user') {
    if (isRunLauncher(row, scope)) return true
    return !row.actor_id && matchesTeam
  }
  if (isTeamScopedRun(row)) {
    return matchesTeam || approvalTargetMatchesUserScope(row, scope)
  }
  return false
}

/**
 * Who may cancel a run: its launcher, or a live admin of the session's scope
 * team for a team run that is not a teammate's own manual run (scheduled or
 * autonomous, or a user run with no actor id). `liveAdmin` is "an active
 * `team_members` row with role `admin` for the scope user and scope team, and
 * a `team_workflow_triggers` row for the scope team and the run's recipe"
 * (`LIVE_SCOPE_TEAM_ADMIN_WITH_RECIPE_GRANT`).
 * Every run this accepts is also accepted by `runMatchesUserScope`, so cancel
 * never reaches a run the caller cannot already see.
 */
export function canCancel(
  row: Pick<WorkflowRunRow, 'actor_type' | 'actor_id' | 'team_id' | 'usage_team_id'>,
  scope: UserRunScope,
  liveAdmin: boolean
): boolean {
  if (isRunLauncher(row, scope)) return true
  return (
    liveAdmin &&
    runMatchesScopeTeam(row, scope) &&
    (isTeamScopedRun(row) || (row.actor_type === 'user' && !row.actor_id))
  )
}

const NON_TERMINAL_RUN_PHASES: ReadonlySet<string> = new Set([
  'Pending',
  'Running',
  'AuthorizationPaused',
])

export function isNonTerminalRunPhase(phase: string): boolean {
  return NON_TERMINAL_RUN_PHASES.has(phase)
}

/**
 * One read per request: is the scope user a live admin of the scope team, and
 * does that team hold a live grant on the recipe. Every row of a recipe's run
 * list shares the recipe, so one answer covers the whole list.
 */
async function isLiveScopeTeamAdminWithRecipeGrant(
  scope: UserRunScope,
  recipeNamespace: string,
  recipeName: string
): Promise<boolean> {
  if (!scope.teamId) return false
  const result = await pool.query(LIVE_SCOPE_TEAM_ADMIN_WITH_RECIPE_GRANT, [
    scope.userId,
    scope.teamId,
    recipeNamespace,
    recipeName,
  ])
  return (result.rowCount ?? 0) > 0
}

function auditRunMatchesUserScope(row: Record<string, unknown>, scope: UserRunScope): boolean {
  const actorType = typeof row.triggerer_actor_type === 'string' ? row.triggerer_actor_type : ''
  const userId = typeof row.triggerer_user_id === 'string' ? row.triggerer_user_id : ''
  const teamId = typeof row.triggerer_team_id === 'string' ? row.triggerer_team_id : ''
  const usageTeamId = typeof row.usage_team_id === 'string' ? row.usage_team_id : ''
  const matchesTeam =
    Boolean(scope.teamId) && (teamId === scope.teamId || usageTeamId === scope.teamId)

  if (actorType === 'user') {
    if (userId && scope.principalIds.includes(userId)) return true
    return !userId && matchesTeam
  }
  if (actorType === 'scheduled' || actorType === 'autonomous') {
    return matchesTeam
  }
  return false
}

export async function canCallerReadWorkflowRunWithApprovalTarget(
  caller: WorkflowRouteCaller,
  row: WorkflowRunRow,
  approvalTarget: WorkflowApprovalTarget = {}
): Promise<boolean> {
  if (caller.kind === 'mcp-host-control') {
    if (isMcpHostDirectlyAuthorizedForRecipe(caller, row.recipe_namespace, row.recipe_name)) {
      return true
    }
    if (!approvalTarget.targetUserId && !approvalTarget.targetTeamId) return true
    if (!row.approval_request_id) return false

    const callerKey = getMcpHostCallerKey(caller.claims)
    const result = await pool.query(
      `SELECT 1
         FROM workflow_approval_requests war
         JOIN workflow_approval_trigger_intents wati
           ON wati.approval_request_id = war.id
         LEFT JOIN team_members tm
           ON tm.team_id = war.target_team_id
          AND tm.user_id = $2::uuid
          AND tm.status = 'active'
        WHERE war.id = $1
          AND (
            ($2::uuid IS NOT NULL AND (
              war.target_user_id = $2::uuid
              OR tm.user_id IS NOT NULL
            ))
            OR ($3::uuid IS NOT NULL AND war.target_team_id = $3::uuid)
          )
          AND wati.trigger_namespace = war.recipe_namespace
          AND wati.trigger_name = war.recipe_name
          AND wati.trigger_caller_key = $4
        LIMIT 1`,
      [
        row.approval_request_id,
        approvalTarget.targetUserId ?? null,
        approvalTarget.targetTeamId ?? null,
        callerKey,
      ]
    )
    return (result.rowCount ?? 0) > 0
  }

  const scope = userRunScope(caller)
  if (!scope) return true
  if (row.actor_type === 'user' && row.actor_id && scope.principalIds.includes(row.actor_id)) {
    return true
  }
  if (
    runMatchesUserScope(row, scope) &&
    (await hasLiveWorkflowTeamGrant(scope, row.recipe_namespace, row.recipe_name))
  ) {
    return true
  }
  if (!row.approval_request_id) return false

  const result = await pool.query(
    `SELECT 1
       FROM workflow_approval_requests war
       LEFT JOIN team_members tm
         ON tm.team_id = war.target_team_id
        AND tm.user_id::text = $4
        AND tm.status = 'active'
       LEFT JOIN team_workflow_triggers twt
         ON twt.team_id = tm.team_id
        AND twt.recipe_namespace = $5
        AND twt.recipe_name = $6
      WHERE war.id = $1
        AND (
          war.target_user_id::text = ANY($2::text[])
          OR (
            war.target_team_id::text = $3
            AND tm.user_id IS NOT NULL
            AND twt.team_id IS NOT NULL
          )
        )
      LIMIT 1`,
    [
      row.approval_request_id,
      scope.principalIds,
      scope.teamId,
      scope.userId,
      row.recipe_namespace,
      row.recipe_name,
    ]
  )
  return (result.rowCount ?? 0) > 0
}

export async function getProviderScopedWorkflowRun(params: {
  caller: WorkflowRouteCaller
  runId: string
  approvalTarget: WorkflowApprovalTarget
  conversationId: string
  db?: DbClient
}): Promise<ProviderScopedWorkflowRunRow | null> {
  const { caller, runId, approvalTarget, conversationId, db = pool } = params
  if (caller.kind !== 'mcp-host-control') return null
  if (!approvalTarget.targetUserId && !approvalTarget.targetTeamId) return null

  const callerKey = getMcpHostCallerKey(caller.claims)
  const result = await db.query(
    `SELECT wr.*,
            war.target_user_id AS approval_target_user_id,
            war.target_team_id AS approval_target_team_id
       FROM workflow_runs wr
       JOIN workflow_approval_requests war
         ON war.id = wr.approval_request_id
       JOIN workflow_approval_trigger_intents wati
         ON wati.approval_request_id = war.id
       LEFT JOIN team_members tm
         ON tm.team_id = war.target_team_id
        AND tm.user_id = $2::uuid
        AND tm.status = 'active'
      WHERE wr.run_id = $1
        AND (
          ($2::uuid IS NOT NULL AND (
            war.target_user_id = $2::uuid
            OR tm.user_id IS NOT NULL
          ))
          OR ($3::uuid IS NOT NULL AND war.target_team_id = $3::uuid)
        )
        AND wati.trigger_namespace = wr.recipe_namespace
        AND wati.trigger_name = wr.recipe_name
        AND wati.trigger_caller_key = $4
        AND war.payload->'metadata'->'workflowTrigger'->>'conversationId' = $5
      LIMIT 1`,
    [
      runId,
      approvalTarget.targetUserId ?? null,
      approvalTarget.targetTeamId ?? null,
      callerKey,
      conversationId,
    ]
  )
  return (result.rows[0] as ProviderScopedWorkflowRunRow | undefined) ?? null
}

function actorFromDbRow(row: WorkflowRunRow): CanonicalRunActor | null {
  switch (row.actor_type) {
    case 'user':
      return {
        type: 'user-session',
        ...(row.actor_id ? { userId: row.actor_id } : {}),
      }
    case 'admin':
      return {
        type: 'admin-ui',
        ...(row.actor_id ? { adminUserId: row.actor_id } : {}),
      }
    case 'autonomous':
      return {
        type: 'mcp-host',
        hostRef: `${row.recipe_namespace}/${row.recipe_name}`,
      }
    case 'scheduled':
      return { type: 'scheduled' }
    default:
      return null
  }
}

function toIso(value: string | null): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : new Date(value as unknown as string).toISOString()
}

/**
 * A run with its cancel request. `mapDbRun` always sets both fields for a run
 * read from `workflow_runs`: both null, or both set once a permitted user or a
 * Control UI operator asked to cancel the run (the request stays on the row
 * after it reaches a terminal phase). Archived runs (`source: 'audit'`) do not carry them, which is why
 * they are optional here: run lists and health reads mix the two sources.
 * What `canceledBy` shows depends on the viewer (see `RunDtoViewer`).
 */
export type CancelAwareRunDto = CanonicalRunDto & {
  cancelRequestedAt?: string | null
  canceledBy?: string | null
}

/** A run in a user-session caller's run list, with that caller's cancel permission. */
export type ViewerCanonicalRunDto = CancelAwareRunDto & {
  viewerCanCancel: boolean
}

/**
 * Who reads a run DTO. `admin` readers (the Control UI routes) see the stored
 * `canceled_by` as is. `tenant` readers (External REST, mcp-host, provider
 * decisions) see an operator cancel (`operator:<subject>`) as `operator`, so
 * the operator's subject stays on the admin surface. The stored column is
 * never rewritten.
 */
export type RunDtoViewer = 'admin' | 'tenant'

const OPERATOR_CANCELED_BY_PREFIX = 'operator:'

function assertRunDtoViewer(viewer: unknown): asserts viewer is RunDtoViewer {
  if (viewer !== 'admin' && viewer !== 'tenant') {
    throw new TypeError("run DTO viewer must be 'admin' or 'tenant'")
  }
}

function canceledByForViewer(canceledBy: string | null, viewer: RunDtoViewer): string | null {
  if (viewer === 'tenant' && canceledBy?.startsWith(OPERATOR_CANCELED_BY_PREFIX)) {
    return 'operator'
  }
  return canceledBy
}

export function mapDbRun(row: WorkflowRunRow, viewer: RunDtoViewer): CancelAwareRunDto {
  assertRunDtoViewer(viewer)
  const executionRef: CanonicalRunExecutionRef | null =
    row.child_recipe_name && row.child_recipe_namespace
      ? { namespace: row.child_recipe_namespace, name: row.child_recipe_name }
      : null
  return {
    id: row.run_id,
    source: 'live',
    approvalRequestId: row.approval_request_id ?? null,
    phase: row.phase,
    triggeredAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    message: row.failure_reason ?? null,
    cancelRequestedAt: toIso(row.cancel_requested_at),
    canceledBy: canceledByForViewer(row.canceled_by, viewer),
    actor: actorFromDbRow(row),
    executionRef,
  }
}

function mapAuditRun(row: Record<string, unknown>): CanonicalRunDto {
  const hostRef = typeof row.triggerer_host_ref === 'string' ? row.triggerer_host_ref : undefined
  const userId = typeof row.triggerer_user_id === 'string' ? row.triggerer_user_id : undefined
  const adminUserId =
    typeof row.triggerer_admin_user_id === 'string' ? row.triggerer_admin_user_id : undefined
  const actorType = hostRef
    ? 'mcp-host'
    : row.triggerer_actor_type === 'scheduled'
      ? 'scheduled'
      : row.triggerer_actor_type === 'autonomous'
        ? 'autonomous'
        : row.triggerer_actor_type === 'admin'
          ? 'admin-ui'
          : 'user-session'

  return {
    id: String(row.run_id),
    source: 'audit',
    approvalRequestId: null,
    phase: String(row.final_phase || 'Failed'),
    triggeredAt: row.triggered_at ? String(row.triggered_at) : null,
    startedAt: row.started_at ? String(row.started_at) : null,
    completedAt: row.completed_at ? String(row.completed_at) : null,
    message: row.error_message ? String(row.error_message) : null,
    actor:
      actorType || userId || hostRef
        ? {
            type: actorType,
            ...(actorType !== 'admin-ui' && userId ? { userId } : {}),
            ...(adminUserId ? { adminUserId } : {}),
            ...(hostRef ? { hostRef } : {}),
          }
        : null,
    executionRef: null,
  }
}

export async function listAuditRunsByRecipe(
  recipeNamespace: string,
  recipeName: string,
  limit: number,
  caller?: WorkflowRouteCaller
): Promise<CanonicalRunDto[]> {
  const scope = caller ? userRunScope(caller) : null
  const auditResult = await pool.query(
    `SELECT run_id, triggerer_user_id, triggerer_admin_user_id, triggerer_team_id,
            usage_team_id,
            triggerer_actor_type, triggerer_host_ref,
            triggered_at, started_at, completed_at, final_phase, error_message
     FROM workflow_runs_audit
     WHERE recipe_namespace = $1 AND recipe_name = $2
       ${
         scope
           ? `AND (
              (triggerer_actor_type = 'user' AND (
                triggerer_user_id::text = ANY($4::text[]) OR
                ((triggerer_user_id::text = ANY($4::text[]) OR triggerer_user_id IS NULL) AND
                 (triggerer_team_id::text = $5 OR usage_team_id = $5) AND
                 EXISTS (
                   SELECT 1 FROM team_members tm
                   JOIN team_workflow_triggers twt ON twt.team_id = tm.team_id
                    AND twt.recipe_namespace = $1 AND twt.recipe_name = $2
                  WHERE tm.user_id::text = $6 AND tm.team_id::text = $5
                    AND tm.status = 'active'
                 ))
              ))
              OR
              (triggerer_actor_type IN ('scheduled', 'autonomous') AND (
                (triggerer_team_id::text = $5 OR usage_team_id = $5) AND
                EXISTS (
                  SELECT 1 FROM team_members tm
                  JOIN team_workflow_triggers twt ON twt.team_id = tm.team_id
                   AND twt.recipe_namespace = $1 AND twt.recipe_name = $2
                 WHERE tm.user_id::text = $6 AND tm.team_id::text = $5
                   AND tm.status = 'active'
                )
              ))
            )`
           : ''
       }
     ORDER BY triggered_at DESC
     LIMIT $3`,
    scope
      ? [recipeNamespace, recipeName, limit, scope.principalIds, scope.teamId, scope.userId]
      : [recipeNamespace, recipeName, limit]
  )

  return auditResult.rows
    .filter(row => !scope || auditRunMatchesUserScope(row, scope))
    .map(mapAuditRun)
}

export function sortRunsNewestFirst(a: CanonicalRunDto, b: CanonicalRunDto): number {
  const aTime = a.triggeredAt ? new Date(a.triggeredAt).getTime() : 0
  const bTime = b.triggeredAt ? new Date(b.triggeredAt).getTime() : 0
  return bTime - aTime
}

export async function getLatestRun(
  recipeNamespace: string,
  recipeName: string,
  viewer: RunDtoViewer,
  caller?: WorkflowRouteCaller
): Promise<CanonicalRunDto | null> {
  assertRunDtoViewer(viewer)
  const scope = caller ? userRunScope(caller) : null
  const liveRows = scope
    ? await listRunsByRecipeForUserScope(recipeNamespace, recipeName, 1, scope)
    : await listRunsByRecipe(recipeNamespace, recipeName, 1)
  const liveRuns = liveRows
    .filter(row => !scope || runMatchesUserScope(row, scope))
    .map(row => mapDbRun(row, viewer))
    .sort(sortRunsNewestFirst)
  const auditRun = (await listAuditRunsByRecipe(recipeNamespace, recipeName, 1, caller))[0] ?? null
  return (
    [liveRuns[0] ?? null, auditRun]
      .filter((run): run is CanonicalRunDto => Boolean(run))
      .sort(sortRunsNewestFirst)[0] ?? null
  )
}

export async function listCanonicalRuns(
  recipeNamespace: string,
  recipeName: string,
  limit: number,
  viewer: RunDtoViewer,
  caller?: WorkflowRouteCaller
): Promise<CanonicalRunDto[]> {
  assertRunDtoViewer(viewer)
  const scope = caller ? userRunScope(caller) : null
  const liveRows = scope
    ? await listRunsByRecipeForUserScope(recipeNamespace, recipeName, limit, scope)
    : await listRunsByRecipe(recipeNamespace, recipeName, limit)
  let liveRuns: CancelAwareRunDto[]
  if (scope) {
    // A user-session list says, per live run, whether this caller may cancel it
    // now: permitted, not finished, and not already asked to cancel.
    // A scope-team run listed through its approval target
    // (listRunsByRecipeForUserScope) is listed without the team's recipe
    // grant, so the grant is read here and not inferred from the list.
    const liveAdmin = await isLiveScopeTeamAdminWithRecipeGrant(scope, recipeNamespace, recipeName)
    liveRuns = liveRows
      .filter(row => runMatchesUserScope(row, scope))
      .map(
        (row): ViewerCanonicalRunDto => ({
          ...mapDbRun(row, viewer),
          viewerCanCancel:
            canCancel(row, scope, liveAdmin) &&
            isNonTerminalRunPhase(row.phase) &&
            row.cancel_requested_at === null,
        })
      )
  } else {
    liveRuns = liveRows.map(row => mapDbRun(row, viewer))
  }
  const liveRunIds = new Set(liveRuns.map(run => run.id))
  const auditRuns = (
    await listAuditRunsByRecipe(recipeNamespace, recipeName, limit, caller)
  ).filter(run => !liveRunIds.has(run.id))
  return [...liveRuns, ...auditRuns].sort(sortRunsNewestFirst).slice(0, limit)
}

export async function getWorkflowHealth(
  recipeNamespace: string,
  recipeName: string,
  viewer: RunDtoViewer,
  caller?: WorkflowRouteCaller
) {
  assertRunDtoViewer(viewer)
  const scope = caller ? userRunScope(caller) : null
  const liveRows = scope
    ? await listRunsByRecipeForUserScope(recipeNamespace, recipeName, 50, scope)
    : await listRunsByRecipe(recipeNamespace, recipeName, 50)
  const liveRuns = liveRows.map(row => mapDbRun(row, viewer)).sort(sortRunsNewestFirst)
  const liveRunIds = new Set(liveRuns.map(run => run.id))
  const latestAuditRun =
    (await listAuditRunsByRecipe(recipeNamespace, recipeName, 1, caller)).find(
      run => !liveRunIds.has(run.id)
    ) ?? null
  const activeRuns = liveRows.filter(
    row => row.phase === 'Pending' || row.phase === 'Running' || row.phase === 'AuthorizationPaused'
  ).length
  const lastRun =
    [liveRuns[0], latestAuditRun]
      .filter((run): run is CanonicalRunDto => Boolean(run))
      .sort(sortRunsNewestFirst)[0] ?? null

  return { activeRuns, lastRun }
}

export async function getLatestWorkflowRunWithApprovalTarget(params: {
  caller: WorkflowRouteCaller
  recipeNamespace: string
  recipeName: string
  approvalTarget?: WorkflowApprovalTarget
  conversationId?: string
  db?: DbClient
}): Promise<WorkflowRunRow | null> {
  const {
    caller,
    recipeNamespace,
    recipeName,
    approvalTarget = {},
    conversationId,
    db = pool,
  } = params

  if (caller.kind === 'mcp-host-control') {
    const hasApprovalTarget = Boolean(approvalTarget.targetUserId || approvalTarget.targetTeamId)
    if (!hasApprovalTarget || !conversationId) {
      if (isMcpHostDirectlyAuthorizedForRecipe(caller, recipeNamespace, recipeName)) {
        const rows = await listRunsByRecipe(recipeNamespace, recipeName, 1, db)
        return rows[0] ?? null
      }
      return null
    }
    const callerKey = getMcpHostCallerKey(caller.claims)
    const result = await db.query(
      `SELECT wr.*
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
        ORDER BY wr.created_at DESC,
                 wr.started_at DESC NULLS LAST
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
    return (result.rows[0] as WorkflowRunRow | undefined) ?? null
  }

  const rows = await listRunsByRecipe(recipeNamespace, recipeName, 1, db)
  const row = rows[0] ?? null
  if (!row) return null
  return (await canCallerReadWorkflowRunWithApprovalTarget(caller, row, approvalTarget))
    ? row
    : null
}

async function listRunsByRecipeForUserScope(
  recipeNamespace: string,
  recipeName: string,
  limit: number,
  scope: UserRunScope
): Promise<ApprovalScopedWorkflowRunRow[]> {
  const result = await pool.query(
    `SELECT wr.*,
            war.target_user_id::text AS approval_target_user_id,
            war.target_team_id::text AS approval_target_team_id,
            tm.user_id::text AS approval_target_team_member_user_id
       FROM workflow_runs wr
       LEFT JOIN workflow_approval_requests war
         ON war.id = wr.approval_request_id
      LEFT JOIN team_members tm
         ON tm.team_id = war.target_team_id
        AND tm.user_id::text = $6
        AND tm.status = 'active'
       LEFT JOIN team_members scope_tm
         ON scope_tm.team_id::text = $5
        AND scope_tm.user_id::text = $6
        AND scope_tm.status = 'active'
       LEFT JOIN team_workflow_triggers scope_twt
         ON scope_twt.team_id = scope_tm.team_id
        AND scope_twt.recipe_namespace = $1
        AND scope_twt.recipe_name = $2
      WHERE wr.recipe_namespace = $1 AND wr.recipe_name = $2
       AND (
         (wr.actor_type = 'user' AND (
           wr.actor_id::text = ANY($4::text[]) OR
           ((wr.actor_id::text = ANY($4::text[]) OR wr.actor_id IS NULL)
            AND (wr.team_id::text = $5 OR wr.usage_team_id = $5)
            AND scope_twt.team_id IS NOT NULL)
         ))
         OR (wr.actor_type IN ('scheduled', 'autonomous') AND (
           (wr.team_id::text = $5 AND scope_twt.team_id IS NOT NULL) OR
           (wr.usage_team_id = $5 AND scope_twt.team_id IS NOT NULL) OR
           war.target_user_id::text = ANY($4::text[]) OR
           (
             war.target_team_id::text = $5
             AND tm.user_id IS NOT NULL
             AND scope_twt.team_id IS NOT NULL
           )
         ))
       )
     ORDER BY wr.created_at DESC,
              wr.started_at DESC NULLS LAST
     LIMIT $3`,
    [recipeNamespace, recipeName, limit, scope.principalIds, scope.teamId, scope.userId]
  )
  return (result.rows as ApprovalScopedWorkflowRunRow[]).filter(row =>
    runMatchesUserScope(row, scope)
  )
}
