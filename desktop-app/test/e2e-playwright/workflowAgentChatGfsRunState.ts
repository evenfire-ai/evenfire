import { expect } from '@playwright/test'
import {
  firstDataLine,
  runControlPostgresSql,
  splitSqlRow,
  sqlLiteral,
} from '../../../tests/e2e/gfsUiFixtures'
import {
  GFS_PLUGIN_NAMESPACE,
  GFS_PLUGIN_RECIPE,
  GFS_PLUGIN_SUBJECT_ID,
} from './workflowAgentChatGfsRuntime'

const GFS_PLUGIN_RUNTIME_SUBJECT = `host:${GFS_PLUGIN_SUBJECT_ID}`

export function workflowRunInfraState(runId: string): { childName: string; phase: string } {
  const row = firstDataLine(
    runControlPostgresSql(`
      SELECT phase || '|' || coalesce(child_recipe_name, '')
        FROM workflow_runs
       WHERE run_id = ${sqlLiteral(runId)}::uuid
         AND recipe_namespace = ${sqlLiteral(GFS_PLUGIN_NAMESPACE)}
         AND recipe_name = ${sqlLiteral(GFS_PLUGIN_RECIPE)};
    `)
  )
  const [phase = '', childName = ''] = splitSqlRow(row)
  return { childName, phase }
}

export async function waitForWorkflowRunSucceeded(runId: string, childName: string): Promise<void> {
  await expect
    .poll(() => workflowRunInfraState(runId), {
      timeout: 600_000,
      intervals: [1_000, 2_000, 5_000],
      message: `infra should observe ${runId} reach Succeeded`,
    })
    .toEqual({ childName, phase: 'Succeeded' })
}

export function expectDurableGfsGrantUsage(fileUri: string): void {
  const auditRows = runControlPostgresSql(`
    SELECT op || '|' || outcome || '|' || count(*)::text
      FROM gfs_audit
     WHERE subject = ${sqlLiteral(GFS_PLUGIN_RUNTIME_SUBJECT)}
       AND gfs_uri = ${sqlLiteral(fileUri)}
     GROUP BY op, outcome
     ORDER BY op, outcome;
  `)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(splitSqlRow)
  const allowed = new Map(
    auditRows.map(([op, outcome, count]) => [`${op}:${outcome}`, Number(count)])
  )
  expect(allowed.get('read:allow') ?? 0).toBeGreaterThanOrEqual(2)
  expect(allowed.get('write:allow') ?? 0).toBeGreaterThanOrEqual(1)
}
