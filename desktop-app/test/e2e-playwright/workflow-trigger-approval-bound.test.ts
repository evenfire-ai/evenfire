import { type Page, expect, test } from '@playwright/test'
import { openResourcesNavItem } from './navigationHelpers'
import {
  approvalStatus,
  createApproval,
  createTeamApproval,
  expectTriggerRejected,
  issueRuntimeTokens,
  triggerWorkflow,
  workflowRunCountForApproval,
} from './workflow-approval-quadrants/approvalApi'
import { expectCreateTeamApprovalRejected } from './workflow-approval-quadrants/approvalRequestExpectations'
import { profilesSql, sqlLiteral } from './workflow-approval-quadrants/cluster'
import { WORKFLOW_RECIPE_NS } from './workflow-approval-quadrants/constants'
import {
  adminCreateTeamForUser,
  allowTeamApprovalThroughAdminRoute,
  applyRecipe,
  cleanupRecipe,
  grantTeamThroughAdminRoute,
  withRuntimeRecipe,
} from './workflow-approval-quadrants/recipes'
import {
  E2E_EMAIL,
  RECIPE_NS,
  clearSession,
  expectWorkflowsPageShell,
  launchAndLogin,
  loginAs,
  selectWorkflow,
} from './workflowUi'

function typedIntentSignal(approvalRequestId: string): string {
  return profilesSql(`
    SELECT trigger_namespace || '/' || trigger_name || ':' || trigger_caller_key
      FROM workflow_approval_trigger_intents
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)};
  `)
}

function workflowRunTeamSignal(runId: string): string {
  return profilesSql(`
    SELECT actor_type || ':' || COALESCE(team_id::text, '<none>')
      FROM workflow_runs
     WHERE run_id::text = ${sqlLiteral(runId)}
     LIMIT 1;
  `)
}

async function waitForLatestWorkflowRun(recipeName: string): Promise<{
  runId: string
  actorType: string
  actorId: string
  teamId: string
}> {
  let row = ''
  await expect
    .poll(
      () => {
        row = profilesSql(`
          SELECT run_id::text || '|' || actor_type || '|' || actor_id::text || '|' || COALESCE(team_id::text, '<none>')
            FROM workflow_runs
           WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
             AND recipe_name = ${sqlLiteral(recipeName)}
           ORDER BY created_at DESC
           LIMIT 1;
        `)
        return row
      },
      {
        timeout: 45_000,
        intervals: [500, 1_000, 2_000],
        message: `timed out waiting for workflow run for ${WORKFLOW_RECIPE_NS}/${recipeName}`,
      }
    )
    .toMatch(/^[0-9a-f-]{36}\|/)

  const [runId, actorType, actorId, teamId] = row.split('|')
  return { runId, actorType, actorId, teamId }
}

function workflowRunTeamSignalForApproval(approvalRequestId: string): string {
  return profilesSql(`
    SELECT actor_type || ':' || COALESCE(team_id::text, '<none>')
      FROM workflow_runs
     WHERE approval_request_id = ${sqlLiteral(approvalRequestId)}
     LIMIT 1;
  `)
}

function workflowRunCountForRecipe(recipeName: string): number {
  return Number(
    profilesSql(`
      SELECT COUNT(*)
        FROM workflow_runs
       WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
         AND recipe_name = ${sqlLiteral(recipeName)};
    `)
  )
}

function sessionTeamId(sessionToken: string): string {
  const payload = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64url').toString()) as {
    teamId?: unknown
  }
  const teamId = String(payload.teamId || '').trim()
  expect(teamId).toMatch(/^[0-9a-f-]{36}$/i)
  return teamId
}

async function openWorkflowsPageThroughDesktopUi(page: Page): Promise<void> {
  await openResourcesNavItem(page, 'nav-workflows')
  await expectWorkflowsPageShell(page)
}

async function approvePendingApprovalThroughDesktopUi(
  page: Page,
  recipeName: string,
  expectedTeamName?: string
): Promise<void> {
  const bell = page.getByRole('button', { name: 'Notifications and approvals' })
  await expect(bell).toBeVisible({ timeout: 20_000 })
  await bell.click()

  const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
  await expect(panel).toBeVisible({ timeout: 10_000 })

  const card = panel.locator('.notification-item').filter({ hasText: recipeName }).first()
  await expect(card).toBeVisible({ timeout: 40_000 })
  if (expectedTeamName) {
    await expect(card).toContainText(`Team: ${expectedTeamName}`)
  }
  await expect(card).toContainText(`Approve ${WORKFLOW_RECIPE_NS}/${recipeName}`)
  await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible()

  const approveButton = card.getByRole('button', { name: 'Approve' })
  await expect(approveButton).toBeEnabled()
  await approveButton.click()

  await expect(page.getByRole('status').filter({ hasText: 'Approval accepted' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(card).not.toBeVisible({ timeout: 20_000 })
}

test('Desktop approval UI authorizes an approval-bound sandbox mcp-host workflow trigger', async ({
  request,
}) => {
  test.setTimeout(240_000)
  await clearSession()

  const { userId } = await loginAs(E2E_EMAIL)
  const recipeName = `e2e-quadrant-desktop-${Date.now()}`

  await withRuntimeRecipe(recipeName, userId, async () => {
    const tokens = await test.step('WRC issues sandbox mcp-host runtime tokens', () =>
      issueRuntimeTokens(request, 'wrc', WORKFLOW_RECIPE_NS, recipeName))

    const approvalId = await test.step('sandbox mcp-host creates trigger-bound approval', () =>
      createApproval(request, tokens, WORKFLOW_RECIPE_NS, recipeName, userId))

    await test.step('pending approval cannot be consumed before Desktop user decision', () =>
      expectTriggerRejected(
        request,
        tokens,
        WORKFLOW_RECIPE_NS,
        recipeName,
        approvalId,
        409,
        'approval_status_not_consumable'
      ))

    expect(approvalStatus(approvalId)).toBe('pending')
    expect(workflowRunCountForApproval(approvalId)).toBe(0)
    expect(typedIntentSignal(approvalId)).toBe(
      `${WORKFLOW_RECIPE_NS}/${recipeName}:${WORKFLOW_RECIPE_NS}/${recipeName}`
    )

    const { app, page } = await launchAndLogin(E2E_EMAIL)
    try {
      await test.step('Desktop shows the pending approval in the approvals panel', async () => {
        const bell = page.getByRole('button', { name: 'Notifications and approvals' })
        await expect(bell).toBeVisible({ timeout: 20_000 })
        await bell.click()

        const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
        await expect(panel).toBeVisible({ timeout: 10_000 })

        const card = panel.locator('.notification-item').filter({ hasText: recipeName }).first()
        await expect(card).toBeVisible({ timeout: 40_000 })
        await expect(card).toContainText(`Approve ${WORKFLOW_RECIPE_NS}/${recipeName}`)
        await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible()

        const approveButton = card.getByRole('button', { name: 'Approve' })
        await expect(approveButton).toBeEnabled()
        await approveButton.click()

        await expect(page.getByRole('status').filter({ hasText: 'Approval accepted' })).toBeVisible(
          {
            timeout: 10_000,
          }
        )
        await expect(card).not.toBeVisible({ timeout: 20_000 })
      })
    } finally {
      await app.close()
    }

    expect(approvalStatus(approvalId)).toBe('approved')
    expect(workflowRunCountForApproval(approvalId)).toBe(0)

    await test.step('sandbox mcp-host consumes the Desktop-approved trigger approval', () =>
      triggerWorkflow(request, tokens, WORKFLOW_RECIPE_NS, recipeName, approvalId))

    expect(approvalStatus(approvalId)).toBe('consumed')
    expect(workflowRunCountForApproval(approvalId)).toBe(1)
  })
})

test('Desktop team context can trigger only through the current team grant', async () => {
  test.setTimeout(300_000)
  await clearSession()

  const { userId } = await loginAs(E2E_EMAIL)
  const suffix = Date.now()
  const recipeName = `e2e-quadrant-desktop-team-direct-${suffix}`
  const teamName = `e2e desktop team direct ${suffix}`

  await cleanupRecipe(recipeName)
  applyRecipe(recipeName, {
    requiresApproval: false,
    instruction: 'E2E direct team-context trigger contract.',
  })

  const teamId = await adminCreateTeamForUser(teamName, userId)
  await grantTeamThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, teamId)

  const { app, page } = await launchAndLogin(E2E_EMAIL)
  try {
    let runId = ''
    await test.step('Desktop triggers the team-granted workflow without a visible team switch', async () => {
      await openWorkflowsPageThroughDesktopUi(page)
      const detailCard = await selectWorkflow(page, recipeName, RECIPE_NS)

      const triggerButton = detailCard.getByRole('button', { name: /^Trigger$/ })
      await expect(triggerButton).toBeVisible({ timeout: 15_000 })
      await triggerButton.click()

      await expect(page.getByRole('status').filter({ hasText: 'Workflow triggered.' })).toBeVisible(
        {
          timeout: 10_000,
        }
      )

      const newRun = await waitForLatestWorkflowRun(recipeName)
      expect(newRun.actorType).toBe('user')
      expect(newRun.actorId).toBe(userId)
      expect(newRun.teamId).toBe(teamId)
      runId = newRun.runId
    })

    expect(workflowRunTeamSignal(runId)).toBe(`user:${teamId}`)

    expect(workflowRunCountForRecipe(recipeName)).toBe(1)
  } finally {
    await app.close()
    await cleanupRecipe(recipeName)
  }
})

test('Desktop team approval preserves the target-team grant boundary for mcp-host consumption', async ({
  request,
}) => {
  test.setTimeout(360_000)
  await clearSession()

  const auth = await loginAs(E2E_EMAIL)
  const { userId } = auth
  const originalTeamId = sessionTeamId(auth.userToken)
  const suffix = Date.now()
  const recipeName = `e2e-quadrant-desktop-team-approval-${suffix}`
  const teamName = `e2e desktop team approval ${suffix}`

  await cleanupRecipe(recipeName)
  applyRecipe(recipeName, {
    requiresApproval: true,
    instruction: 'E2E approval-bound team-context trigger contract.',
  })

  const teamId = await adminCreateTeamForUser(teamName, userId)
  await grantTeamThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, teamId)
  await allowTeamApprovalThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, teamId)
  await allowTeamApprovalThroughAdminRoute(WORKFLOW_RECIPE_NS, recipeName, originalTeamId)

  const tokens = await issueRuntimeTokens(request, 'wrc', WORKFLOW_RECIPE_NS, recipeName)
  const approvalId = await createTeamApproval(
    request,
    tokens,
    WORKFLOW_RECIPE_NS,
    recipeName,
    teamId
  )

  expect(approvalStatus(approvalId)).toBe('pending')
  expect(workflowRunCountForApproval(approvalId)).toBe(0)
  expect(typedIntentSignal(approvalId)).toBe(
    `${WORKFLOW_RECIPE_NS}/${recipeName}:${WORKFLOW_RECIPE_NS}/${recipeName}`
  )

  const { app, page } = await launchAndLogin(E2E_EMAIL)
  try {
    await test.step('Desktop approves the Team B target approval without a visible team switch', () =>
      approvePendingApprovalThroughDesktopUi(page, recipeName, teamName))

    expect(approvalStatus(approvalId)).toBe('approved')
    expect(workflowRunCountForApproval(approvalId)).toBe(0)

    await test.step('mcp-host consumes the Desktop-approved Team B approval', () =>
      triggerWorkflow(request, tokens, WORKFLOW_RECIPE_NS, recipeName, approvalId))

    expect(approvalStatus(approvalId)).toBe('consumed')
    expect(workflowRunCountForApproval(approvalId)).toBe(1)
    expect(workflowRunTeamSignalForApproval(approvalId)).toBe(`autonomous:${teamId}`)

    await test.step('Control API rejects Team A approval when only Team B has trigger grant', async () => {
      await expectCreateTeamApprovalRejected(
        request,
        tokens,
        WORKFLOW_RECIPE_NS,
        recipeName,
        originalTeamId,
        403,
        'Target not authorized to trigger this recipe'
      )
      expect(workflowRunCountForRecipe(recipeName)).toBe(1)
      expect(
        Number(
          profilesSql(`
            SELECT COUNT(*)
              FROM workflow_approval_requests
             WHERE recipe_namespace = ${sqlLiteral(WORKFLOW_RECIPE_NS)}
               AND recipe_name = ${sqlLiteral(recipeName)}
               AND target_team_id = ${sqlLiteral(originalTeamId)};
          `)
        )
      ).toBe(0)
    })
  } finally {
    await app.close()
    await cleanupRecipe(recipeName)
  }
})
