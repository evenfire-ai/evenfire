import { expect, test } from '@playwright/test'
import {
  clearSession,
  launchAndLogin,
  openWorkflowsPage,
  rendererListWorkflows,
} from './workflowUi'

test('user without grants sees the workflows empty state', async () => {
  await clearSession()

  // Unauthorized coverage is the intentional exception to the canonical
  // seeded E2E identity. Normal workflow/approval specs must use
  // test@clerum.io via workflowUi.ts.
  const noGrantsEmail = `unauthorized-${Date.now()}@clerum.io`
  const { app, page } = await launchAndLogin(noGrantsEmail)

  try {
    await openWorkflowsPage(page)

    const workflows = await rendererListWorkflows(page)
    expect(workflows.count).toBe(0)

    await expect(page.getByText('No workflows')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.contexts-table-body .context-table-row')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test("user without grants never sees another user's workflow name", async () => {
  await clearSession()

  const noGrantsEmail = `unauthorized-${Date.now()}@clerum.io`
  const { app, page } = await launchAndLogin(noGrantsEmail)

  try {
    await openWorkflowsPage(page)
    await expect(page.locator('.contexts-table-body .context-table-row')).toHaveCount(0)
    await expect(page.getByText('e2e-ondemand-simple')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
