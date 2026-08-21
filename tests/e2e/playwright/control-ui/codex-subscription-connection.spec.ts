/**
 * Codex subscription — Control UI connection journey.
 *
 * Contract:
 * - Entry point: application root `/` (E2E_GUARDIAN_ENTRY_POINT).
 * - Actions: visible login, open LLM Models, open the Codex subscription surface.
 * - Route/state: `/llm-models/providers/codex-subscription` after UI navigation.
 * - UI: Connect controls and Disconnected status; no tokens or account ids.
 * - Business signal: waitForResponse on GET /connection (capability + status).
 *
 * This journey does not complete ChatGPT OAuth. That is the real-upstream lane.
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

    const connection = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm/providers/codex-subscription/connection') &&
        response.request().method() === 'GET'
    )
    await page.getByRole('link', { name: 'Codex subscription' }).click()
    const response = await connection
    expect(response.ok(), `connection read must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { status?: string }
    expect(body.status).toBe('disconnected')
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)
    await expect(page.getByRole('heading', { name: 'Codex subscription' })).toBeVisible()
    await expect(page.getByTestId('codex-connection-status')).toContainText(/Disconnected/)
    await expect(page.getByRole('button', { name: 'Connect in browser' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use device code' })).toBeVisible()
    await expect(page.getByText(/sk-|access token|account id/i)).toHaveCount(0)
  })

  test('browser connect fails loud with the default CLI client and keeps device code available', async ({
    page,
  }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await page.getByRole('link', { name: 'LLM Models' }).click()
    await page.getByRole('link', { name: 'Codex subscription' }).click()
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)

    const browserStart = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm/providers/codex-subscription/browser/start') &&
        response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Connect in browser' }).click()
    const response = await browserStart
    expect(response.status(), 'default CLI client must not open browser OAuth').toBe(400)
    const body = (await response.json()) as { error?: string }
    expect(body.error).toBe('browser_oauth_unregistered')
    await expect(page.getByTestId('codex-browser-oauth-blocked')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Use device code' })).toBeVisible()
    await expect(page).not.toHaveURL(/auth\.openai\.com/)
  })
})
