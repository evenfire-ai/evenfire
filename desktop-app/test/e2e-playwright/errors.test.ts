// desktop-app/test/e2e-playwright/errors.test.ts
import { expect, test } from './fixtures.js'
import { openAgentsPage } from './navigationHelpers.js'

const E2E_HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

test('9. sending a message returns the composer to an interactive state', async ({ appPage }) => {
  await openAgentsPage(appPage)
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  const agentLink = appPage.locator('.agents-table-row-clickable', { hasText: E2E_HOST_REF })
  const emptyState = appPage.locator('text=No agents available')
  await expect(chatInput.or(agentLink.first()).or(emptyState)).toBeVisible({ timeout: 20_000 })
  if (await emptyState.isVisible()) {
    test.skip(true, 'No agents available — skip')
    return
  }
  if (await agentLink.first().isVisible()) {
    await agentLink.first().click()
  }

  await chatInput.waitFor({ state: 'visible', timeout: 10_000 })
  await appPage.getByRole('button', { name: /new thread/i }).click()
  await expect(appPage.locator('[data-testid="agent-response"]')).toHaveCount(0, {
    timeout: 10_000,
  })

  const responseCountBefore = await appPage.locator('[data-testid="agent-response"]').count()
  await chatInput.fill('Reply with: ERROR_TEST')
  await appPage.locator('[data-testid="send-button"]').click()

  const newResponse = appPage.locator('[data-testid="agent-response"]').nth(responseCountBefore)
  await expect(newResponse).toBeVisible({ timeout: 15_000 })
  await expect(newResponse).toContainText('ERROR_TEST')

  // The composer should exit the sending state and accept fresh input again.
  await expect(appPage.locator('[data-testid="send-button"]')).toHaveText('Send Message', {
    timeout: 15_000,
  })
  await expect(chatInput).toBeVisible()
  await chatInput.fill('Recovered composer')
  await expect(appPage.locator('[data-testid="send-button"]')).toBeEnabled()

  // Verify no unhandled error dialog
  const dialogs: string[] = []
  appPage.on('dialog', dialog => {
    dialogs.push(dialog.message())
    dialog.dismiss()
  })
  expect(dialogs).toHaveLength(0)
})
