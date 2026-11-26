import type { Pool } from 'pg'
import { type DbClient, pool, withTransaction } from '../../db.js'
import { canonicalWorkflowRunId } from '../access/workflowRunId.js'
import { cancelPendingRequestsForRun } from '../userApprovalRequestService.js'
import type { WorkflowRunRow } from '../workflowRunService.js'
import type { WorkflowRouteCaller } from './types.js'
import { canCancel, userRunScope } from './workflowRunReadService.js'

export class WorkflowRunCancelError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'workflow_run_not_found' | 'workflow_run_not_cancellable'
  ) {
    super(code)
    this.name = 'WorkflowRunCancelError'
  }
}

/** Step 1: the run row, locked for the rest of the cancel transaction. */
export const LOCK_RUN_FOR_CANCEL = `
  SELECT *
    FROM workflow_runs
   WHERE run_id = $1::uuid
     AND recipe_namespace = $2
     AND recipe_name = $3
   FOR UPDATE`

/**
 * Step 2: whether the caller is a live admin of the session's scope team. The
 * share lock makes a concurrent demotion wait for this cancel to commit.
 */
export const LOCK_LIVE_SCOPE_TEAM_ADMIN_FOR_CANCEL = `
  SELECT 1
    FROM team_members
   WHERE user_id = $1
     AND team_id = $2
     AND role = 'admin'
     AND status = 'active'
   FOR SHARE`

/**
 * Step 3, run without a child: nothing runs for it yet, so the cancel ends it.
 * The row trigger on `phase` sends the `workflow_run_update` notification.
 */
export const CANCEL_RUN_WITHOUT_CHILD = `
  UPDATE workflow_runs
     SET phase = 'Canceled',
         completed_at = now(),
         cancel_requested_at = now(),
         canceled_by = $2,
         last_reconciled_at = now(),
         updated_at = now()
   WHERE run_id = $1::uuid
     AND phase IN ('Pending', 'AuthorizationPaused')
     AND child_recipe_name IS NULL
   RETURNING *`

/**
 * Step 3, run with a child: the request is stored and the child's coordinator
 * stops cooperatively once workflow-recipes delivers the cancel signal; the
 * phase is left to workflow-recipes.
 */
export const REQUEST_CANCEL_OF_RUN_WITH_CHILD = `
  UPDATE workflow_runs
     SET cancel_requested_at = now(),
         canceled_by = $2,
         updated_at = now()
   WHERE run_id = $1::uuid
     AND cancel_requested_at IS NULL
   RETURNING *`

/**
 * The row trigger notifies only on a phase change, so a request stored without
 * one (or asked for again) is announced explicitly.
 */
export const NOTIFY_RUN_UPDATE = `SELECT pg_notify('workflow_run_update', $1::text)`

type UserSessionCaller = Extract<WorkflowRouteCaller, { kind: 'user-session' }>

async function notifyRunUpdate(db: DbClient, runId: string): Promise<void> {
  await db.query(NOTIFY_RUN_UPDATE, [runId])
}

function requireUpdatedRow(rows: unknown[], statement: string, runId: string): WorkflowRunRow {
  const row = rows[0] as WorkflowRunRow | undefined
  // The row is locked by step 1 and its state was checked under that lock, so
  // the update must match it.
  if (!row) throw new Error(`${statement} matched no row for locked workflow run ${runId}`)
  return row
}

/**
 * Cancels a workflow run for a user-session caller, in one transaction:
 * lock the run, check the caller may cancel it (a caller who may not gets the
 * same 404 as for a missing run), then by phase: `Canceled` or an existing
 * request answers with the row unchanged; `Succeeded` and `Failed` are not
 * cancellable; a run without a child becomes `Canceled`; a run with a child
 * gets a cancel request. A run that got a request has its unexpired pending
 * step approvals cancelled in the same transaction.
 */
export async function cancelWorkflowRun(input: {
  runId: string
  recipeNamespace: string
  recipeName: string
  caller: UserSessionCaller
  db?: Pool
}): Promise<WorkflowRunRow> {
  // A run id that is not the canonical text of a uuid names no run; checked
  // before the statements cast it.
  if (!canonicalWorkflowRunId(input.runId)) {
    throw new WorkflowRunCancelError(404, 'workflow_run_not_found')
  }
  const scope = userRunScope(input.caller)
  if (!scope) throw new Error('cancelWorkflowRun requires a user-session caller')
  const cancelledBy = input.caller.claims.userId

  return withTransaction(async db => {
    const locked = await db.query(LOCK_RUN_FOR_CANCEL, [
      input.runId,
      input.recipeNamespace,
      input.recipeName,
    ])
    const run = locked.rows[0] as WorkflowRunRow | undefined
    if (!run) throw new WorkflowRunCancelError(404, 'workflow_run_not_found')

    const launcher = canCancel(run, scope, false)
    let liveAdmin = false
    if (!launcher && scope.teamId) {
      const admin = await db.query(LOCK_LIVE_SCOPE_TEAM_ADMIN_FOR_CANCEL, [
        scope.userId,
        scope.teamId,
      ])
      liveAdmin = (admin.rowCount ?? 0) > 0
    }
    if (!launcher && !canCancel(run, scope, liveAdmin)) {
      throw new WorkflowRunCancelError(404, 'workflow_run_not_found')
    }

    switch (run.phase) {
      case 'Canceled':
        return run
      case 'Succeeded':
      case 'Failed':
        throw new WorkflowRunCancelError(409, 'workflow_run_not_cancellable')
      case 'Pending':
      case 'Running':
      case 'AuthorizationPaused':
        break
      default:
        throw new Error(`workflow run ${input.runId} has unknown phase ${String(run.phase)}`)
    }

    if (run.cancel_requested_at !== null) {
      // Asked before: the first canceller stays recorded; the notification is
      // sent again so a lost delivery is retried.
      await notifyRunUpdate(db, input.runId)
      return run
    }

    let cancelled: WorkflowRunRow
    if (run.child_recipe_name === null) {
      if (run.phase === 'Running') {
        // Only legacy rows: a claim sets the child together with `Running`.
        throw new WorkflowRunCancelError(409, 'workflow_run_not_cancellable')
      }
      const updated = await db.query(CANCEL_RUN_WITHOUT_CHILD, [input.runId, cancelledBy])
      cancelled = requireUpdatedRow(updated.rows, 'CANCEL_RUN_WITHOUT_CHILD', input.runId)
    } else {
      const updated = await db.query(REQUEST_CANCEL_OF_RUN_WITH_CHILD, [input.runId, cancelledBy])
      cancelled = requireUpdatedRow(updated.rows, 'REQUEST_CANCEL_OF_RUN_WITH_CHILD', input.runId)
      await notifyRunUpdate(db, input.runId)
    }

    await cancelPendingRequestsForRun(db, input.runId, cancelledBy)
    return cancelled
  }, input.db ?? pool)
}
