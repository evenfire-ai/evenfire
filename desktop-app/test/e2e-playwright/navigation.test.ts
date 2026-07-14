// desktop-app/test/e2e-playwright/navigation.test.ts
import { expect, test } from './fixtures.js'
import { openAgentsPage } from './navigationHelpers.js'

test('2. sidebar navigation renders all main pages', async ({ appPage }) => {
  for (const nav of ['nav-chat', 'nav-sandbox-ui']) {
    const link = appPage.locator(`[data-testid="${nav}"]`)
    await expect(link).toBeVisible()
    await link.click()
    await expect(link).toHaveClass(/active/)
  }

  await openAgentsPage(appPage)
  await expect(
    appPage
      .getByRole('heading', { name: 'Agents', exact: true })
      .or(appPage.getByTestId('chat-input'))
  ).toBeVisible({ timeout: 20_000 })
})

test('3. agents page shows agent list from catalog', async ({ appPage }) => {
  await openAgentsPage(appPage)
  // With 1 agent the app auto-selects it → chat view is shown (no table).
  // With >1 agents → the agents table is shown.
  // With 0 agents → "No agents available" empty state.
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  const agentRows = appPage.locator('.agents-table-row-clickable')
  const emptyState = appPage.locator('text=No agents available')
  await expect(chatInput.or(agentRows.first()).or(emptyState)).toBeVisible({ timeout: 20_000 })

  if (await emptyState.isVisible()) {
    test.skip(true, 'No agents assigned to this user — skip catalog check')
    return
  }
  // Either the chat view or agent table is visible — agent(s) loaded
  const hasChat = await chatInput.isVisible()
  const hasTable = await agentRows.first().isVisible()
  expect(hasChat || hasTable).toBe(true)
})
