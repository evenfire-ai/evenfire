// Workflow run cancel from the Desktop Workflows table (C6 PW1 and PW3).
//
// Fixtures come from scripts/minikube/seed-workflow-triggers-test-data.sh:
// e2e-cancel-two-step and e2e-cancel-scheduled hold a run in Running on a step
// approval that no test decides; trigger-member-e2e@clerum.io is an active member
// (not admin) of the trigger team, and the Desktop user is its active admin.
//
// The row, the Cancel button and the phase pill are located by role and test id in
// the flat Plugins table. workflowRow()/selectWorkflow() in workflowUi.ts target the
// old list/detail layout and are not used here.
//
// Some acceptance signals have no External REST endpoint (the step approval's
// cancelled status and canceller, the step rows, the run's team and trigger
// source). Those are read from the profiles database through kubectl, read-only,
// the way workflowUi.ts seeds and cleans its fixtures.
import { type Locator, type Page, expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { WorkflowRunListItem } from '../../src/types'
import {
  E2E_EMAIL,
  EXT_API,
  K8S_CONTEXT,
  RECIPE_NS,
  apiListPendingApprovals,
  apiListWorkflowRuns,
  apiRequest,
  cleanupRecipeRuntimeState,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  rendererListWorkflowRuns,
  waitForNewRun,
} from './workflowUi'

const RECIPE_TWO_STEP = 'e2e-cancel-two-step'
const RECIPE_SCHEDULED = 'e2e-cancel-scheduled'
const MEMBER_EMAIL = 'trigger-member-e2e@clerum.io'
const HOLD_STEP_ID = 'hold-for-approval'
const SECOND_STEP_ID = 'after-approval'
// A cron that cannot recur during the test: PW3 forces one fire through
// next_fire_at, and the worker then advances the cursor to next year.
const ONE_SHOT_CRON = '0 0 1 1 *'
const HOLD_TIMEOUT_MS = 240_000
const CANCEL_SETTLE_TIMEOUT_MS = 180_000

type CancelableRun = WorkflowRunListItem & { canceledBy?: string | null }

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function kubectl(args: string[], timeout = 20_000): string {
  return execFileSync('kubectl', ['--context', K8S_CONTEXT, ...args], {
    encoding: 'utf-8',
    timeout,
  })
}

function profilesSql(sql: string): string {
  const pgPod = kubectl([
    '-n',
    'control-plane',
    'get',
    'pod',
    '-l',
    'app=control-postgres',
    '-o',
    'jsonpath={.items[0].metadata.name}',
  ]).trim()
  if (!pgPod) throw new Error('control-postgres pod not found')
  return kubectl([
    '-n',
    'control-plane',
    'exec',
    pgPod,
    '--',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
    '-d',
    'profiles',
    '-t',
    '-A',
    '-F',
    '|',
    '-c',
    sql,
  ]).trim()
}

function stepApprovalsOf(runId: string): Array<{ status: string; cancelledBy: string }> {
  const out = profilesSql(
    `SELECT status, COALESCE(cancelled_by, '') FROM workflow_approval_requests
      WHERE bound_workflow_run_id = ${sqlLiteral(runId)} ORDER BY created_at`
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [status, cancelledBy] = line.split('|')
      return { status: status ?? '', cancelledBy: cancelledBy ?? '' }
    })
}

function stepIdsOf(runId: string): string[] {
  return profilesSql(
    `SELECT step_id FROM workflow_run_steps WHERE run_id = ${sqlLiteral(runId)} ORDER BY step_id`
  )
    .split('\n')
    .filter(Boolean)
}

function recipeRowIn(page: Page, recipeName: string): Locator {
  return page.getByRole('row').filter({ has: page.getByText(recipeName, { exact: true }) })
}

// The row's Cancel opens a confirmation at page level; the cancel is sent from its
// "Cancel run" button.
async function clickCancelAndConfirm(page: Page, row: Locator): Promise<void> {
  await row.getByRole('button', { name: 'Cancel run' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await dialog.getByRole('button', { name: 'Cancel run' }).click()
}

async function findRun(
  sessionToken: string,
  recipeName: string,
  runId: string
): Promise<CancelableRun | undefined> {
  const runs = await apiListWorkflowRuns(sessionToken, RECIPE_NS, recipeName, 20)
  return (runs.items as CancelableRun[]).find(item => item.id === runId)
}

/**
 * Wait until the run is Running with a child and its first step holds on a pending
 * step approval addressed to the approver. This is the intermediate state every
 * cancel below starts from.
 */
async function waitUntilHoldingOnApproval(
  runToken: string,
  approverToken: string,
  recipeName: string,
  runId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const run = await findRun(runToken, recipeName, runId)
        if (!run) return 'run not listed'
        if (run.phase !== 'Running' || !run.executionRef) {
          return `phase=${run.phase} child=${run.executionRef ? 'yes' : 'no'}`
        }
        const approvals = await apiListPendingApprovals(approverToken, 50)
        const pending = approvals.some(
          item =>
            item.recipeNamespace === RECIPE_NS &&
            item.recipeName === recipeName &&
            item.correlation?.stepId === HOLD_STEP_ID
        )
        return pending ? 'holding' : 'running without a pending step approval'
      },
      {
        timeout: HOLD_TIMEOUT_MS,
        intervals: [1_000, 2_000, 5_000],
        message: `${recipeName} run ${runId} never held on a pending step approval`,
      }
    )
    .toBe('holding')
}

async function apiCancelRun(
  sessionToken: string,
  recipeName: string,
  runId: string
): Promise<{ status: number; body: string }> {
  return apiRequest(
    'POST',
    `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(recipeName)}/runs/${encodeURIComponent(runId)}/cancel`,
    undefined,
    { Authorization: `Bearer ${sessionToken}` }
  )
}

function installOneShotSchedule(recipeName: string): void {
  kubectl([
    '-n',
    RECIPE_NS,
    'patch',
    'workflowrecipe',
    recipeName,
    '--type=merge',
    '-p',
    JSON.stringify({ spec: { triggers: { schedule: { cron: ONE_SHOT_CRON, timezone: 'UTC' } } } }),
  ])
}

function removeSchedule(recipeName: string): void {
  const hasSchedule = kubectl([
    '-n',
    RECIPE_NS,
    'get',
    'workflowrecipe',
    recipeName,
    '-o',
    'jsonpath={.spec.triggers.schedule.cron}',
  ]).trim()
  if (hasSchedule) {
    kubectl([
      '-n',
      RECIPE_NS,
      'patch',
      'workflowrecipe',
      recipeName,
      '--type=json',
      '-p',
      JSON.stringify([{ op: 'remove', path: '/spec/triggers/schedule' }]),
    ])
  }
  profilesSql(
    `DELETE FROM workflow_schedules WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
       AND recipe_name = ${sqlLiteral(recipeName)}`
  )
}

test('PW1: cancel a running run from the Workflows table', async () => {
  test.setTimeout(600_000)
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_TWO_STEP)

  const admin = await loginAs(E2E_EMAIL)
  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    const row = recipeRowIn(page, RECIPE_TWO_STEP)
    await expect(row).toBeVisible({ timeout: 30_000 })

    const run =
      await test.step('trigger from the Desktop and hold on the step approval', async () => {
        await row.getByRole('button', { name: 'Trigger' }).click()
        await expect(
          page.getByRole('status').filter({ hasText: 'Workflow triggered.' })
        ).toBeVisible({ timeout: 10_000 })
        // cleanupRecipeRuntimeState() left no runs, so the first run is this test's.
        const created = await waitForNewRun(page, RECIPE_NS, RECIPE_TWO_STEP, [])
        expect(created.actor?.userId).toBe(admin.userId)
        await waitUntilHoldingOnApproval(
          admin.userToken,
          admin.userToken,
          RECIPE_TWO_STEP,
          created.id
        )
        // The cell is not refreshed outside Canceling, so only the button is asserted
        // here; the Running phase was asserted through the API above.
        await expect(row.getByRole('button', { name: 'Cancel run' })).toBeVisible({
          timeout: 30_000,
        })
        return created
      })

    await test.step('click Cancel and confirm: the cell reads Canceling', async () => {
      await clickCancelAndConfirm(page, row)
      await expect(row.getByTestId('workflow-latest-run-phase')).toHaveText('Canceling', {
        timeout: 30_000,
      })
      await expect(row.getByRole('button', { name: 'Cancel run' })).toHaveCount(0)
    })

    await test.step('without reload or Refresh the cell reaches Canceled', async () => {
      await expect(row.getByTestId('workflow-latest-run-phase')).toHaveText('Canceled', {
        timeout: CANCEL_SETTLE_TIMEOUT_MS,
      })
    })

    await test.step('business signals', async () => {
      const after = await findRun(admin.userToken, RECIPE_TWO_STEP, run.id)
      expect(after?.phase).toBe('Canceled')
      expect(after?.cancelRequestedAt).toBeTruthy()
      expect(after?.canceledBy).toBe(admin.userId)
      expect(stepApprovalsOf(run.id)).toEqual([{ status: 'cancelled', cancelledBy: admin.userId }])
      const steps = stepIdsOf(run.id)
      // Liveness witness: the first step's row exists, so the read reached the run.
      expect(steps).toContain(HOLD_STEP_ID)
      expect(steps).not.toContain(SECOND_STEP_ID)
    })
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_TWO_STEP)
  }
})

test('PW3: a team admin cancels the team scheduled run, not a teammate run', async () => {
  test.setTimeout(900_000)
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_TWO_STEP)
  cleanupRecipeRuntimeState(RECIPE_SCHEDULED)
  removeSchedule(RECIPE_SCHEDULED)

  const admin = await loginAs(E2E_EMAIL)
  const member = await loginAs(MEMBER_EMAIL)
  let app: Awaited<ReturnType<typeof launchAndLogin>>['app'] | null = null

  try {
    const { memberRunId, scheduledRunId } =
      await test.step('setup: a member run and a scheduled run both hold on a step approval', async () => {
        const trigger = await apiRequest(
          'POST',
          `${EXT_API}/api/v1/workflows/${encodeURIComponent(RECIPE_NS)}/${encodeURIComponent(RECIPE_TWO_STEP)}/trigger`,
          JSON.stringify({}),
          { Authorization: `Bearer ${member.userToken}`, 'Idempotency-Key': randomUUID() }
        )
        expect(trigger.status, trigger.body).toBeLessThan(300)
        let memberRun: CancelableRun | undefined
        await expect
          .poll(
            async () => {
              const runs = await apiListWorkflowRuns(member.userToken, RECIPE_NS, RECIPE_TWO_STEP)
              memberRun = runs.items[0] as CancelableRun | undefined
              return memberRun ? 'listed' : 'not listed'
            },
            { timeout: 60_000, intervals: [1_000, 2_000] }
          )
          .toBe('listed')
        if (!memberRun) throw new Error('member run not listed')
        expect(memberRun.actor?.userId).toBe(member.userId)

        installOneShotSchedule(RECIPE_SCHEDULED)
        await expect
          .poll(
            () =>
              profilesSql(
                `SELECT COUNT(*) FROM workflow_schedules WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
                   AND recipe_name = ${sqlLiteral(RECIPE_SCHEDULED)}`
              ),
            { timeout: 120_000, intervals: [2_000, 5_000] }
          )
          .toBe('1')
        profilesSql(
          `UPDATE workflow_schedules SET next_fire_at = now()
            WHERE recipe_namespace = ${sqlLiteral(RECIPE_NS)}
              AND recipe_name = ${sqlLiteral(RECIPE_SCHEDULED)}`
        )
        let scheduledRun: CancelableRun | undefined
        await expect
          .poll(
            async () => {
              const runs = await apiListWorkflowRuns(admin.userToken, RECIPE_NS, RECIPE_SCHEDULED)
              scheduledRun = runs.items[0] as CancelableRun | undefined
              return scheduledRun ? 'fired' : 'not fired'
            },
            { timeout: 180_000, intervals: [2_000, 5_000] }
          )
          .toBe('fired')
        if (!scheduledRun) throw new Error('scheduled run not listed')

        await waitUntilHoldingOnApproval(
          member.userToken,
          admin.userToken,
          RECIPE_TWO_STEP,
          memberRun.id
        )
        await waitUntilHoldingOnApproval(
          admin.userToken,
          admin.userToken,
          RECIPE_SCHEDULED,
          scheduledRun.id
        )
        // Precondition witness: the scheduler's run is a team run of the trigger team.
        expect(scheduledRun.actor?.type).toBe('scheduled')
        const recipeTeamId = kubectl([
          '-n',
          RECIPE_NS,
          'get',
          'workflowrecipe',
          RECIPE_SCHEDULED,
          '-o',
          'jsonpath={.metadata.labels.clerum\\.io/workflow-team-id}',
        ]).trim()
        expect(recipeTeamId).toMatch(/^[0-9a-f-]{36}$/)
        expect(
          profilesSql(
            `SELECT team_id::text || '/' || COALESCE(trigger_source, '') FROM workflow_runs
              WHERE run_id = ${sqlLiteral(scheduledRun.id)}`
          )
        ).toBe(`${recipeTeamId}/schedule`)
        return { memberRunId: memberRun.id, scheduledRunId: scheduledRun.id }
      })

    const launched = await launchAndLogin()
    app = launched.app
    const page = launched.page
    await openWorkflowsPage(page)
    const scheduledRow = recipeRowIn(page, RECIPE_SCHEDULED)

    await test.step('the scheduled run shows the Cancel button', async () => {
      await expect(scheduledRow).toBeVisible({ timeout: 30_000 })
      await expect(scheduledRow.getByRole('button', { name: 'Cancel run' })).toBeVisible({
        timeout: 30_000,
      })
    })

    await test.step('cancel it: Canceling, then Canceled, recorded as the admin', async () => {
      await clickCancelAndConfirm(page, scheduledRow)
      const pill = scheduledRow.getByTestId('workflow-latest-run-phase')
      await expect(pill).toHaveText('Canceling', { timeout: 30_000 })
      await expect(pill).toHaveText('Canceled', { timeout: CANCEL_SETTLE_TIMEOUT_MS })
      const after = await findRun(admin.userToken, RECIPE_SCHEDULED, scheduledRunId)
      expect(after?.cancelRequestedAt).toBeTruthy()
      expect(after?.canceledBy).toBe(admin.userId)
    })

    await test.step('the admin does not receive the member run', async () => {
      const adminView = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_TWO_STEP)
      expect(adminView.items.map(item => item.id)).not.toContain(memberRunId)
      // Liveness witness: the member's own list has the run in the same test.
      const memberView = await apiListWorkflowRuns(member.userToken, RECIPE_NS, RECIPE_TWO_STEP)
      expect(memberView.items.map(item => item.id)).toContain(memberRunId)
    })

    await test.step('direct access: the admin gets 404 on the member run; the member cancels it', async () => {
      const denied = await apiCancelRun(admin.userToken, RECIPE_TWO_STEP, memberRunId)
      expect(denied.status, denied.body).toBe(404)
      const unchanged = await findRun(member.userToken, RECIPE_TWO_STEP, memberRunId)
      expect(unchanged?.phase).toBe('Running')
      expect(unchanged?.cancelRequestedAt ?? null).toBeNull()

      const accepted = await apiCancelRun(member.userToken, RECIPE_TWO_STEP, memberRunId)
      expect(accepted.status, accepted.body).toBe(200)
      const requested = await findRun(member.userToken, RECIPE_TWO_STEP, memberRunId)
      expect(requested?.cancelRequestedAt).toBeTruthy()
      expect(requested?.canceledBy).toBe(member.userId)
    })
  } finally {
    if (app) await app.close()
    removeSchedule(RECIPE_SCHEDULED)
    cleanupRecipeRuntimeState(RECIPE_TWO_STEP)
    cleanupRecipeRuntimeState(RECIPE_SCHEDULED)
  }
})
