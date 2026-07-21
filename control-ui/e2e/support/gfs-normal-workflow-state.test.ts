import { expect } from '@playwright/test'
import { firstDataLine, runControlPostgresSql, sqlLiteral } from '../../../tests/e2e/gfsUiFixtures'
import {
  EXPECTED_HELD_STATE,
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
} from './gfs-normal-workflow-constants'

export function normalGfsPluginRunState(
  runId: string,
  childName: string,
  recipeName = GFS_PLUGIN_RECIPE
): string {
  return firstDataLine(
    runControlPostgresSql(`
      SELECT approval.status || '|' || step.step_id || '|' || step.phase || '|' ||
             (step.started_at IS NOT NULL)::text || '|' ||
             (step.completed_at IS NULL)::text || '|' ||
             (step.output IS NULL)::text || '|' ||
             (step.tools_called IS NULL)::text || '|' ||
             (step.error IS NULL)::text || '|' ||
             (SELECT COUNT(*)::text FROM agent_run_events event
               WHERE event.run_id = step.run_id
                 AND event.event_type IN ('llm_call', 'tool_call'))
        FROM workflow_approval_requests approval
        JOIN workflow_run_steps step
          ON step.run_id = approval.bound_workflow_run_id
         AND step.step_id = approval.bound_workflow_step_id
        JOIN workflow_runs run
          ON run.run_id = step.run_id
         AND run.recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
         AND run.recipe_name = ${sqlLiteral(recipeName)}
         AND run.child_recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
         AND run.child_recipe_name = ${sqlLiteral(childName)}
       WHERE approval.bound_workflow_run_id = ${sqlLiteral(runId)}::uuid
         AND approval.recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
         AND approval.recipe_name = ${sqlLiteral(recipeName)}
       ORDER BY approval.requested_at DESC LIMIT 1;
    `)
  )
}

export function normalGfsPluginRunDiagnostic(
  runId: string,
  childName: string,
  recipeName = GFS_PLUGIN_RECIPE
): string {
  return runControlPostgresSql(`
    SELECT json_build_object(
             'runPhase', run.phase,
             'childRecipeName', run.child_recipe_name,
             'stepId', step.step_id,
             'stepPhase', step.phase,
             'stepError', step.error,
             'approvalStatus', approval.status,
             'approvalRecipeName', approval.recipe_name,
             'llmOrToolEvents', (
               SELECT COUNT(*)
                 FROM agent_run_events event
                WHERE event.run_id = run.run_id
                  AND event.event_type IN ('llm_call', 'tool_call')
             )
           )::text
      FROM workflow_runs run
      LEFT JOIN workflow_run_steps step
        ON step.run_id = run.run_id
       AND step.step_id = 'approval-held-gfs-read'
      LEFT JOIN workflow_approval_requests approval
        ON approval.bound_workflow_run_id = run.run_id
       AND approval.bound_workflow_step_id = step.step_id
       AND approval.recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND approval.recipe_name = ${sqlLiteral(recipeName)}
     WHERE run.run_id = ${sqlLiteral(runId)}::uuid
       AND run.recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND run.recipe_name = ${sqlLiteral(recipeName)}
       AND run.child_recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
       AND run.child_recipe_name = ${sqlLiteral(childName)};
  `).trim()
}

export function expectNormalGfsPluginRunHeld(
  runId: string,
  childName: string,
  recipeName = GFS_PLUGIN_RECIPE
): void {
  expect(normalGfsPluginRunState(runId, childName, recipeName)).toBe(EXPECTED_HELD_STATE)
}
