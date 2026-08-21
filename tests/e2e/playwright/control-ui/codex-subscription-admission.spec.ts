/**
 * Codex subscription — Control UI admission and route guards.
 *
 * Contract:
 * - Entry point: application root `/` for authenticated journeys.
 * - Negative guard: unauthenticated deep link must not expose broker controls.
 * - UI: Codex subscription nav link appears only after capability is proven.
 * - Business signal: GET /connection succeeds with disconnected status when enabled.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription admission', () => {
  test('unauthenticated deep link is blocked by AuthGate', async ({ page }) => {
    // route guard: unauthenticated deep link must not expose broker controls
    await page.goto('/llm-models/providers/codex-subscription')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('codex-connection-status')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
  })

  test('catalog surface exposes Codex subscription only after capability is proven', async ({
    page,
  }) => {
    // E2E_GUARDIAN_ENTRY_POINT
    await page.goto('/')
    await loginControlUiVisible(page)

    const capability = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm/providers/codex-subscription/connection') &&
        response.request().method() === 'GET'
    )
    await page.getByRole('link', { name: 'LLM Models' }).click()
    await expect(page).toHaveURL(/\/llm-models/)
    const capabilityResponse = await capability
    expect(
      capabilityResponse.ok(),
      `capability probe must succeed, got ${capabilityResponse.status()}`
    ).toBe(true)

    const body = (await capabilityResponse.json()) as { status?: string }
    expect(body.status).toBe('disconnected')

    await expect(page.getByRole('tab', { name: 'Codex subscription' })).toBeVisible()
  })
})
