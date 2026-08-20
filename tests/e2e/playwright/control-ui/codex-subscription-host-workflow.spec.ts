/**
 * Codex subscription — Host and WorkflowRecipe authoring journey.
 *
 * Contract:
 * - Entry point: application root `/` (E2E_GUARDIAN_ENTRY_POINT).
 * - Actions: visible login, open Agents, create an agent with Codex provider.
 * - Route/state: Agents create form after sidebar navigation.
 * - UI: Codex Subscription is selectable and does not require a Secret.
 * - Business signal: waitForResponse on the Host create mutation.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription host and workflow authoring', () => {
  test('operator can select Codex Subscription without a Host Secret', async ({ page }) => {
    // E2E_GUARDIAN_ENTRY_POINT
    await page.goto('/')
    await loginControlUiVisible(page)

    await page.getByRole('link', { name: 'Agents' }).click()
    await expect(page).toHaveURL(/\/agents/)
    await page.getByRole('button', { name: 'Create agent' }).click()

    await page.getByLabel('Model provider').selectOption('codex-subscription')
    await expect(page.getByLabel('Secret reference')).toHaveCount(0)

    const created = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/hosts') &&
        response.request().method() === 'POST' &&
        response.ok()
    )
    await page.getByRole('button', { name: 'Create agent' }).click()
    await created
  })
})
