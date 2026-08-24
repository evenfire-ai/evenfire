/**
 * Codex subscription — Control UI admission and route guards.
 *
 * Contract:
 * - Unauthenticated deep link to an agent model tab must not expose Connect.
 * - LLM Models no longer owns ChatGPT assignment; the old URL has no Connect owner.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription admission', () => {
  test('unauthenticated Secrets Subscription deep link is blocked by AuthGate', async ({
    page,
  }) => {
    await page.goto('/secrets/subscription')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('codex-subscription-hub')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Revoke subscription' })).toHaveCount(0)
  })

  test('unauthenticated agent model deep link is blocked by AuthGate', async ({ page }) => {
    await page.goto('/agents/e2e-codex-authoring/model')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('codex-agent-assignment')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
  })

  test('LLM Models no longer owns Codex assignment', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)

    await page.getByRole('link', { name: 'LLM Models' }).click()
    await expect(page).toHaveURL(/\/llm-models/)
    await expect(page.getByRole('tab', { name: 'Codex subscription' })).toHaveCount(0)

    await page.goto('/llm-models/providers/codex-subscription')
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
    await expect(page.getByTestId('codex-connection-status')).toHaveCount(0)
  })
})
