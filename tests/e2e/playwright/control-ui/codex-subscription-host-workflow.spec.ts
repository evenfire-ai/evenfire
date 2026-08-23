/**
 * Codex subscription — Host authoring journey.
 *
 * Contract:
 * - Entry point: application root `/` (E2E_GUARDIAN_ENTRY_POINT).
 * - Actions: visible login, open Agents, start Create agent, choose Codex.
 * - Route/state: `/agents/new` Model & credentials step.
 * - UI: OpenAI + ChatGPT subscription is selectable and requires no LLM secret.
 * - Business signal: waitForResponse on the allowlist catalog used to populate models.
 *
 * A live catalog model is not asserted: Sync/enable is the connection lane.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription host and workflow authoring', () => {
  test('operator can select Codex Subscription without a Host Secret', async ({ page }) => {
    // E2E_GUARDIAN_ENTRY_POINT
    await page.goto('/')
    await loginControlUiVisible(page)

    await page.getByRole('link', { name: 'Agents', exact: true }).click()
    await expect(page).toHaveURL(/\/(?:hosts|agents)$/)

    const catalog = page.waitForResponse(
      response =>
        response.url().includes('/api/v1/admin/llm-models') && response.request().method() === 'GET'
    )
    await page.getByRole('button', { name: 'Create agent', exact: true }).click()
    await expect(page).toHaveURL(/\/(?:hosts|agents)\/new$/)
    const catalogResponse = await catalog
    expect(catalogResponse.ok()).toBe(true)
    const catalogBody = (await catalogResponse.json()) as {
      rows?: Array<{ provider?: string; enabled?: boolean }>
    }
    expect(Array.isArray(catalogBody.rows)).toBe(true)

    await page.getByPlaceholder('agent-name').fill('e2e-codex-authoring')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByText('Create new context', { exact: true }).click()
    await page.getByPlaceholder('context-name').fill('e2e-codex-ctx')
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Model & credentials', { exact: true })).toBeVisible()

    await page.getByLabel('Provider').click()
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await expect(page.getByRole('option', { name: 'OpenAI Codex Subscription' })).toHaveCount(0)
    await page.getByRole('radio', { name: 'ChatGPT subscription' }).check()
    await expect(
      page.getByText(/This OpenAI credential authenticates through a ChatGPT subscription/)
    ).toBeVisible()
    await expect(page.getByLabel('Secret name')).toHaveCount(0)
    await expect(page.getByLabel(/OpenAI API key/i)).toHaveCount(0)
    await expect(page.getByTestId('codex-agent-assignment')).toBeVisible()
  })
})
