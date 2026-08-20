/**
 * Codex subscription — Control UI connection journey.
 *
 * Contract:
 * - Entry point: application root `/` (E2E_GUARDIAN_ENTRY_POINT).
 * - Actions: visible login, open LLM Models, open Codex Subscription provider.
 * - Route/state: `/llm-models/providers/codex-subscription` after UI navigation.
 * - UI: connect/catalog surface without tokens or account ids.
 * - Business signal: waitForResponse on the provider catalog/status query.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription connection', () => {
  test('operator can open the Codex subscription connection surface', async ({ page }) => {
    // E2E_GUARDIAN_ENTRY_POINT
    await page.goto('/')
    await loginControlUiVisible(page)

    await page.getByRole('link', { name: 'LLM Models' }).click()
    await expect(page).toHaveURL(/\/llm-models/)

    const catalog = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm/providers/codex-subscription') &&
        response.request().method() === 'GET'
    )
    await page.getByRole('link', { name: 'Codex Subscription' }).click()
    const response = await catalog
    expect(response.ok()).toBe(true)
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)
    await expect(page.getByRole('heading', { name: 'Codex Subscription' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible()
    await expect(page.getByText(/sk-|access token|account id/i)).toHaveCount(0)
  })
})
