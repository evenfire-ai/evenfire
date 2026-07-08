import { type Page, expect, test } from '@playwright/test'
import {
  E2E_EMAIL,
  RECIPE_NS,
  clearSession,
  expectWorkflowsPageShell,
  launchAndLogin,
  loginAs,
  openWorkflowsPage,
  rendererListWorkflows,
  seedAllowlist,
  workflowRow,
} from './workflowUi'

const RECIPE_NAME = 'e2e-ondemand-simple'
const WORKFLOW_TEST_HOOKS = '[data-testid="workflows-page"], [data-testid="workflow-row"]'

async function expectNoWorkflowTestHooks(page: Page) {
  await expect(page.locator(WORKFLOW_TEST_HOOKS)).toHaveCount(0)
}

test('workflows page renders in the sidebar and loads the real page shell', async () => {
  await clearSession()

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    await expectNoWorkflowTestHooks(page)
    await expectWorkflowsPageShell(page)

    const workflows = await rendererListWorkflows(page)
    const firstWorkflowName = workflows.items[0]?.metadata?.name
    if (firstWorkflowName) {
      await expect(page.getByRole('button').filter({ hasText: firstWorkflowName })).toBeVisible({
        timeout: 15_000,
      })
    } else {
      await expect(page.getByText('No recipes are deployed in this cluster.')).toBeVisible({
        timeout: 15_000,
      })
    }
  } finally {
    await app.close()
  }
})

test('seeded workflow grants appear in the desktop list', async () => {
  await clearSession()

  const auth = await loginAs(E2E_EMAIL)
  seedAllowlist(auth.userId, RECIPE_NAME)

  const { app, page } = await launchAndLogin()

  try {
    await openWorkflowsPage(page)
    await expectNoWorkflowTestHooks(page)

    const workflows = await rendererListWorkflows(page)
    expect(workflows.items.some(item => item.metadata?.name === RECIPE_NAME)).toBe(true)

    const recipeEntry = workflowRow(page, RECIPE_NAME)
    await expect(recipeEntry).toBeVisible({ timeout: 30_000 })
  } finally {
    await app.close()
  }
})

test('a user with no workflow grants sees the empty state', async () => {
  await clearSession()

  const noGrantsEmail = `no-grants-${Date.now()}@clerum.io`
  const { app, page } = await launchAndLogin(noGrantsEmail)

  try {
    await openWorkflowsPage(page)
    await expectNoWorkflowTestHooks(page)

    const workflows = await rendererListWorkflows(page)
    expect(workflows.count).toBe(0)

    await expect(page.getByText('No recipes are deployed in this cluster.')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByRole('button').filter({ hasText: RECIPE_NS })).toHaveCount(0)
  } finally {
    await app.close()
  }
})
