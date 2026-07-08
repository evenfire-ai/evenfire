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
  seedAllowlist,
  selectWorkflow,
  shortRunId,
  waitForNewRun,
} from './workflowUi'

const RECIPE_NAME = 'e2e-ondemand-simple'

test('desktop-triggered runs are attributed to the logged-in user', async () => {
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_NAME)

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_NAME)

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

    const beforeRuns = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
    const beforeIds = beforeRuns.items.map(item => item.id)

    await detailCard.getByRole('button', { name: 'Trigger' }).click()
    const newRun = await waitForNewRun(page, RECIPE_NS, RECIPE_NAME, beforeIds)

    expect(newRun.actor?.type).toBe('user-session')
    expect(newRun.actor?.userId).toBe(auth.userId)

    await detailCard.getByRole('button', { name: 'Refresh' }).click()
    await expect(
      detailCard
        .locator('.context-resource-row')
        .filter({ hasText: shortRunId(newRun.id) })
        .first()
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_NAME)
  }
})

test('desktop-triggered runs eventually carry an executionRef', async () => {
  await clearSession()
  cleanupRecipeRuntimeState(RECIPE_NAME)

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_NAME)

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    const detailCard = await selectWorkflow(page, RECIPE_NAME, RECIPE_NS)

    const beforeRuns = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
    const beforeIds = beforeRuns.items.map(item => item.id)

    await detailCard.getByRole('button', { name: 'Trigger' }).click()
    const newRun = await waitForNewRun(page, RECIPE_NS, RECIPE_NAME, beforeIds)

    let claimedRun = newRun
    await expect
      .poll(
        async () => {
          const runs = await rendererListWorkflowRuns(page, RECIPE_NS, RECIPE_NAME, 20)
          const match = runs.items.find(item => item.id === newRun.id)
          if (match?.executionRef?.namespace && match?.executionRef?.name) {
            claimedRun = match
            return `${match.executionRef.namespace}/${match.executionRef.name}`
          }
          return null
        },
        {
          timeout: 60_000,
          intervals: [500, 1_000, 2_000],
          message: `run ${newRun.id} did not claim an executionRef`,
        }
      )
      .not.toBeNull()

    expect(claimedRun.executionRef).not.toBeNull()
    expect(claimedRun.executionRef?.namespace).toBe(RECIPE_NS)
    // Per docs/architecture/workflow-recipe-naming.md, WRC's child-recipe
    // naming uses an 8-char short run-id suffix (first hex octet of the
    // UUIDv4) — NOT the full 36-char UUID — so the name is 63-byte-safe for
    // every downstream K8s label surface. Match against the short suffix
    // only; `runUUID[:8]` is unique across `workflow_runs` per parent
    // thanks to idx_wr_idempotency, so it is a sufficient identifier.
    const shortRunId = newRun.id.toLowerCase().slice(0, 8)
    expect(claimedRun.executionRef?.name).toContain(shortRunId)
  } finally {
    await app.close()
    cleanupRecipeRuntimeState(RECIPE_NAME)
  }
})
