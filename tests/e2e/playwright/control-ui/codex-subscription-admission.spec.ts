/**
 * Codex subscription — Control UI admission and route guards.
 *
 * Negative contract (direct terminal access is the behavior under test here):
 * - Unauthenticated `/secrets/llm/subscriptions` must show login, not the table.
 * - Unauthenticated `/agents/:name/model` must show login, not credentials.
 * - LLM Models is no longer the ChatGPT assignment owner.
 */
import { expect, test } from '@playwright/test'
import {
  isSubscriptionAdmissionAuthProbe,
  observeProtectedSubscriptionBusinessAccess,
} from '../helpers/subscription-admission-guard'

test.describe('Codex subscription admission', () => {
  for (const guard of [
    {
      name: 'nested Subscriptions deep link',
      path: '/secrets/llm/subscriptions',
      next: '/secrets/llm/subscriptions',
    },
    {
      name: 'legacy Subscription deep link',
      path: '/secrets/subscription',
      next: '/secrets/llm/subscriptions',
    },
    {
      name: 'agent model deep link',
      path: '/agents/e2e-codex-authoring/model',
      next: '/agents/e2e-codex-authoring/model',
    },
  ]) {
    test(`unauthenticated ${guard.name} is blocked before protected business access`, async ({
      page,
    }) => {
      const attemptedBusiness = observeProtectedSubscriptionBusinessAccess(page)
      const authProbe = page.waitForResponse(response =>
        isSubscriptionAdmissionAuthProbe(response.url(), response.request().method())
      )
      // Negative deep-link guard: direct access is the behavior under test.
      await page.goto(guard.path)
      const authentication = await authProbe
      expect(authentication.status()).toBe(401)
      await expect(page).toHaveURL(
        // The public root owns sign-in; next retains the protected destination.
        url => url.pathname === '/' && url.searchParams.get('next') === guard.next
      )
      await expect(page.getByLabel('Username or email')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
      await expect(page.getByLabel('Main navigation')).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Add subscription' })).toHaveCount(0)
      await expect(page.getByRole('columnheader', { name: 'Name' })).toHaveCount(0)
      await expect(page.getByLabel('Credential', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
      // AuthGate has settled after its real 401 probe and visible login render.
      // Assert attempts, not only successful responses: even a denied protected
      // request would reveal a guard bypass in this unauthenticated context.
      expect(attemptedBusiness).toEqual([])
    })
  }

  test('LLM Models no longer owns Codex assignment', async ({ page }) => {
    // E2E_GUARDIAN_ENTRY_POINT: legitimate root entry for the visible login.
    await page.goto('/')
    const { loginControlUiVisible } = await import('../helpers/visible-login')
    await loginControlUiVisible(page)

    await test.step('sidebar LLM Models has no Codex subscription tab', async () => {
      await page.getByRole('link', { name: 'LLM Models' }).click()
      await expect(page).toHaveURL(/\/llm-models/)
      await expect(page.getByRole('tab', { name: 'Codex subscription' })).toHaveCount(0)
    })

    await test.step('legacy provider URL does not expose Connect', async () => {
      // Negative legacy terminal-route guard: direct access is intentional.
      await page.goto('/llm-models/providers/codex-subscription')
      await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
      await expect(page.getByTestId('codex-connection-status')).toHaveCount(0)
    })
  })
})
