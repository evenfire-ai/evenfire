/**
 * Codex subscription — Control UI admission and route guards.
 *
 * Negative contract (direct terminal access is the behavior under test here):
 * - Unauthenticated `/secrets/llm/subscriptions` must show login, not the table.
 * - Unauthenticated `/agents/:name/model` must show login, not credentials.
 * - LLM Models is no longer the ChatGPT assignment owner.
 */
import { type Page, type Response, expect, test } from '@playwright/test'
import {
  isSubscriptionAdmissionAuthProbe,
  observeProtectedSubscriptionBusinessAccess,
} from '../helpers/subscription-admission-guard'
import { loginControlUiVisible } from '../helpers/visible-login'

test.describe('Codex subscription admission', () => {
  function observeUnauthenticatedAccess(page: Page) {
    const attemptedBusiness = observeProtectedSubscriptionBusinessAccess(page)
    const authProbe = page.waitForResponse(response =>
      isSubscriptionAdmissionAuthProbe(response.url(), response.request().method())
    )
    return { attemptedBusiness, authProbe }
  }

  async function assertAuthGate(
    page: Page,
    next: string,
    attemptedBusiness: string[],
    authProbe: Promise<Response>
  ) {
    const authentication = await authProbe
    expect(authentication.status()).toBe(401)
    await expect(page).toHaveURL(
      // The public root owns sign-in; next retains the protected destination.
      url => url.pathname === '/' && url.searchParams.get('next') === next
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
  }

  test('unauthenticated nested Subscriptions deep link is blocked', async ({ page }) => {
    const { attemptedBusiness, authProbe } = observeUnauthenticatedAccess(page)
    // E2E_GUARDIAN_NAVIGATION: negative-route-guard — protected subscriptions must show login
    await page.goto('/secrets/llm/subscriptions')
    await assertAuthGate(page, '/secrets/llm/subscriptions', attemptedBusiness, authProbe)
  })

  test('unauthenticated legacy Subscription deep link redirects safely', async ({ page }) => {
    const { attemptedBusiness, authProbe } = observeUnauthenticatedAccess(page)
    // E2E_GUARDIAN_NAVIGATION: negative-route-guard — legacy protected route must show login
    await page.goto('/secrets/subscription')
    await assertAuthGate(page, '/secrets/llm/subscriptions', attemptedBusiness, authProbe)
  })

  test('unauthenticated agent model deep link is blocked', async ({ page }) => {
    const { attemptedBusiness, authProbe } = observeUnauthenticatedAccess(page)
    // E2E_GUARDIAN_NAVIGATION: negative-route-guard — protected agent model must show login
    await page.goto('/agents/e2e-codex-authoring/model')
    await assertAuthGate(page, '/agents/e2e-codex-authoring/model', attemptedBusiness, authProbe)
  })

  test('LLM Models no longer owns Codex assignment', async ({ page }) => {
    // E2E_GUARDIAN_NAVIGATION: root-entry — legitimate root before visible login
    await page.goto('/')
    await loginControlUiVisible(page)

    await test.step('sidebar LLM Models has no Codex subscription tab', async () => {
      await page.getByRole('link', { name: 'LLM Models' }).click()
      await expect(page).toHaveURL(/\/llm-models/)
      await expect(page.getByRole('tab', { name: 'Codex subscription' })).toHaveCount(0)
    })

    await test.step('legacy provider URL does not expose Connect', async () => {
      // E2E_GUARDIAN_NAVIGATION: negative-route-guard — legacy terminal route stays disabled
      await page.goto('/llm-models/providers/codex-subscription')
      await expect(page.getByRole('button', { name: 'Sign in with ChatGPT' })).toHaveCount(0)
      await expect(page.getByTestId('codex-connection-status')).toHaveCount(0)
    })
  })
})
