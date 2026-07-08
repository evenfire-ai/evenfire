import { expect, test } from '@playwright/test'
import {
  E2E_EMAIL,
  RECIPE_NS,
  cleanupRecipeRuntimeState,
  clearSession,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  rendererListWorkflowRuns,
  rendererTriggerWorkflow,
  seedAllowlist,
  selectWorkflow,
  shortRunId,
  waitForNewRun,
} from './workflowUi'

const RECIPE_NAME = 'e2e-ondemand-simple'

test('desktop workflow IPC honors idempotency keys', async () => {
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_NAME)

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_NAME)

  const { app, page } = await launchAndLogin()

  try {
    const idempotencyKey = `desktop-idemp-${Date.now()}`

    await openWorkflowsPage(page)
    await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

    const beforeRuns = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
    const beforeIds = beforeRuns.items.map(item => item.id)

    const first = await rendererTriggerWorkflow(page, RECIPE_NS, RECIPE_NAME, idempotencyKey)
    const second = await rendererTriggerWorkflow(page, RECIPE_NS, RECIPE_NAME, idempotencyKey)

    const firstId = String((first as { id?: string }).id || '')
    const secondId = String((second as { id?: string }).id || '')
    expect(firstId).not.toBe('')
    expect(secondId).toBe(firstId)

    const run = await waitForNewRun(page, RECIPE_NS, RECIPE_NAME, beforeIds)
    expect(run.id).toBe(firstId)

    const detailCard = page.locator('.workflows-detail-card')
    await detailCard.getByRole('button', { name: 'Refresh', exact: true }).click()
    const runRow = detailCard
      .locator('.context-resource-row')
      .filter({ hasText: shortRunId(firstId) })
      .first()
    await expect(runRow).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_NAME)
  }
})
