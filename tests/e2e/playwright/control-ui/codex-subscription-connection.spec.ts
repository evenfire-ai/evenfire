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
    await page.getByRole('tab', { name: 'Codex subscription' }).click()
    const response = await connection
    expect(response.ok(), `connection read must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { status?: string }
    expect(body.status).toBe('disconnected')
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)
    await expect(page.getByRole('heading', { name: 'Codex subscription' })).toBeVisible()
    await expect(page.getByTestId('codex-connection-status')).toContainText(/Disconnected/)
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeVisible()
    await expect(page.getByText(/sk-|access token|account id/i)).toHaveCount(0)
  })

  test('Sign in with ChatGPT starts the ChatGPT device login and stays on control-ui', async ({
    page,
  }) => {
    await page.goto('/')
    await loginControlUiVisible(page)
    await page.getByRole('link', { name: 'LLM Models' }).click()
    await page.getByRole('tab', { name: 'Codex subscription' }).click()
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)

    const deviceStart = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm/providers/codex-subscription/device/start') &&
        response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Sign in with ChatGPT' }).click()
    const response = await deviceStart
    expect(response.ok(), `device start must succeed, got ${response.status()}`).toBe(true)
    const body = (await response.json()) as { userCode?: string; verificationUri?: string }
    expect(body.userCode, 'ChatGPT sign-in must return a user code').toEqual(expect.any(String))
    expect(body.verificationUri).toMatch(/^https:\/\/auth\.openai\.com\/codex\/device/)
    await expect(page.getByTestId('codex-device-code')).toContainText(String(body.userCode))
    await expect(page).toHaveURL(/\/llm-models\/providers\/codex-subscription/)
    await expect(page).not.toHaveURL(/oauth\/authorize/)
  })
})
