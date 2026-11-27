import type { DbClient } from '../db.js'

export const WORKFLOW_RUN_CANCEL_REQUEST_MIGRATION = '0160_workflow_run_cancel_request'

export const WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK = 'workflow_runs_cancel_request_pair_check'

/**
 * Workflow run cancellation columns. `cancel_requested_at` records when a cancel
 * was accepted and `canceled_by` who asked for it: the user id of a user-session
 * caller, or `operator:<admin user id>` for a Control UI operator; the two are
 * set together or not at all. The archive copies both into
 * `workflow_runs_audit`. Existing rows get NULL in both columns, which satisfies
 * the pair check, and a second run adds nothing: the columns use
 * `IF NOT EXISTS` and the check is created only when it is missing.
 */
export async function applyWorkflowRunCancelRequestSchema(
  db: Pick<DbClient, 'query'>
): Promise<void> {
  await db.query(`
    ALTER TABLE workflow_runs
      ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS canceled_by TEXT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = 'workflow_runs'::regclass
           AND conname = '${WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK}'
      ) THEN
        ALTER TABLE workflow_runs
          ADD CONSTRAINT ${WORKFLOW_RUN_CANCEL_REQUEST_PAIR_CHECK}
          CHECK ((cancel_requested_at IS NULL) = (canceled_by IS NULL));
      END IF;
    END $$;

    ALTER TABLE workflow_runs_audit
      ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ NULL,
      ADD COLUMN IF NOT EXISTS canceled_by TEXT NULL;
  `)
}
