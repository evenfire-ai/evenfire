/**
 * Codex subscription — Control UI admission and route guards.
 *
 * Negative contract (direct terminal access is the behavior under test here):
 * - Unauthenticated `/secrets/llm/subscriptions` must show login, not the table.
 * - Unauthenticated `/agents/:name/model` must show login, not credentials.
 * - LLM Models is no longer the ChatGPT assignment owner.
 */
import { expect, test } from '@playwright/test'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription admission', () => {
  test('unauthenticated nested Subscriptions deep link is blocked by AuthGate', async ({
    page,
  }) => {
    await page.goto('/secrets/llm/subscriptions')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Add subscription' })).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveCount(0)
  })

  test('unauthenticated legacy Subscription path is blocked by AuthGate', async ({ page }) => {
    await page.goto('/secrets/subscription')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Add subscription' })).toHaveCount(0)
  })

  test('unauthenticated agent model deep link is blocked by AuthGate', async ({ page }) => {
    await page.goto('/agents/e2e-codex-authoring/model')
    await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByLabel('Credential', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
  })

  test('LLM Models no longer owns Codex assignment', async ({ page }) => {
    await page.goto('/')
    await loginControlUiVisible(page)

    await test.step('sidebar LLM Models has no Codex subscription tab', async () => {
      await page.getByRole('link', { name: 'LLM Models' }).click()
      await expect(page).toHaveURL(/\/llm-models/)
      await expect(page.getByRole('tab', { name: 'Codex subscription' })).toHaveCount(0)
    })

    await test.step('legacy provider URL does not expose Connect', async () => {
      await page.goto('/llm-models/providers/codex-subscription')
      await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
      await expect(page.getByTestId('codex-connection-status')).toHaveCount(0)
    })
  })
})
