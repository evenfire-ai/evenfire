import { expect, test } from '@playwright/test'
import {
  E2E_EMAIL,
  RECIPE_NS,
  apiListPendingApprovals,
  cleanupRecipeRuntimeState,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  seedAllowlist,
  selectWorkflow,
  shortRunId,
  waitForNewRun,
  waitForPendingApprovalsToIncrease,
} from './workflowUi'

const RECIPE_SIMPLE = 'e2e-ondemand-simple'
const RECIPE_APPROVAL = 'e2e-ondemand-approval'

test('desktop trigger button creates a new workflow run', async () => {
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_SIMPLE)

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_SIMPLE)

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    const detailCard = await selectWorkflow(page, RECIPE_SIMPLE, RECIPE_NS)

    const triggerBtn = detailCard.getByRole('button', { name: 'Trigger' })
    await expect(triggerBtn).toBeVisible({ timeout: 15_000 })
    await triggerBtn.click()

    await expect(page.getByRole('status').filter({ hasText: 'Workflow triggered.' })).toBeVisible({
      timeout: 10_000,
    })

    // cleanupRecipeRuntimeState() leaves this recipe with no residual runs, so
    // the first run we observe after the trigger is the one created by this test.
    const newRun = await waitForNewRun(page, RECIPE_NS, RECIPE_SIMPLE, [])
    expect(newRun.actor?.type).toBe('user-session')
    expect(newRun.actor?.userId).toBe(auth.userId)
    expect(['Pending', 'Running']).toContain(newRun.phase)

    await detailCard.getByRole('button', { name: 'Refresh', exact: true }).click()
    const runRow = detailCard
      .locator('.context-resource-row')
      .filter({ hasText: shortRunId(newRun.id) })
      .first()
    await expect(runRow).toBeVisible({ timeout: 30_000 })
    await expect(runRow).toContainText(/Pending|Running/)
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_SIMPLE)
  }
})

test('triggering an approval-gated workflow creates a pending approval', async () => {
  test.setTimeout(240_000)
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_APPROVAL)

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_APPROVAL)

  const { app, page } = await launchAndLogin()

  try {
    const beforeApprovals = await apiListPendingApprovals(auth.userToken, 20)
    const beforeIds = beforeApprovals.map(item => item.id)

    await openWorkflowsPage(page)
    const detailCard = await selectWorkflow(page, RECIPE_APPROVAL, RECIPE_NS)

    const triggerBtn = detailCard.getByRole('button', { name: 'Trigger' })
    await expect(triggerBtn).toBeVisible({ timeout: 15_000 })
    await triggerBtn.click()

    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Approval requested. Open notifications to approve.' })
    ).toBeVisible({
      timeout: 10_000,
    })

    const freshApprovals = await waitForPendingApprovalsToIncrease(auth.userToken, beforeIds, {
      timeoutMs: 180_000,
      recipeNs: RECIPE_NS,
      recipeName: RECIPE_APPROVAL,
    })
    expect(
      freshApprovals.some(
        item => item.recipeNamespace === RECIPE_NS && item.recipeName === RECIPE_APPROVAL
      )
    ).toBe(true)

    const bell = page.getByRole('button', { name: 'Notifications and approvals' })
    await bell.click()
    const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(panel).toBeVisible({ timeout: 5_000 })
    const approvalCard = panel
      .locator('.notification-item')
      .filter({ hasText: RECIPE_APPROVAL })
      .first()
    await expect(approvalCard).toBeVisible({ timeout: 20_000 })
    await expect(approvalCard.getByRole('button', { name: 'Approve' })).toBeVisible()
    await expect(approvalCard.getByRole('button', { name: 'Deny' })).toBeVisible()
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_APPROVAL)
  }
})
