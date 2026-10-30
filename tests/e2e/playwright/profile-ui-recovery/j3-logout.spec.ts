import { expect, test } from '@playwright/test'
import {
  LOGOUT_MEMBER,
  expectBrowserRoute,
  fetchMeWithCookie,
  readControlApiMetrics,
  sessionCookieValue,
  signInThroughUi,
} from './journeys'

test('J3 logout returns to login and the previous session is rejected', async ({ page }) => {
  // E2E_GUARDIAN_NAVIGATION: root-entry — the ordinary login that owns the session
  await page.goto('/')
  await signInThroughUi(page, LOGOUT_MEMBER.email, LOGOUT_MEMBER.password)
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(
    page.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })
  ).toBeVisible()

  const priorSession = await sessionCookieValue(page)
  expect(priorSession).toBeTruthy()
  if (!priorSession) throw new Error('login did not set a profile session')

  // Logout from an authenticated sub-route so the resulting home URL is a real
  // navigation signal instead of the page's starting URL.
  await page.getByRole('link', { name: 'Settings' }).click()
  await expect(page).toHaveURL(/\/settings\/profile$/)
  await expectBrowserRoute(page, { pathname: '/settings/profile' })

  const logoutResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/auth/logout') && response.request().method() === 'POST'
  )
  await page.locator('aside').getByRole('button', { name: 'Log out' }).click()
  const logoutResult = await logoutResponse
  expect(logoutResult.status()).toBe(200)

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })).toHaveCount(
    0
  )
  expect(await sessionCookieValue(page)).toBeNull()

  const oldSession = await fetchMeWithCookie(page, priorSession)
  expect(oldSession.status).toBe(401)

  await page.goto('/')
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })).toHaveCount(
    0
  )

  const metrics = await readControlApiMetrics(page)
  expect(metrics.logoutRequests).toContainEqual({ hasToken: true })
  expect(metrics.loginSuccesses).toContainEqual({ userId: LOGOUT_MEMBER.id })
})
