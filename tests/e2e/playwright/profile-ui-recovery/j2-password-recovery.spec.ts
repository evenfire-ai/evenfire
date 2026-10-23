import { expect, test } from '@playwright/test'
import {
  LOGOUT_MEMBER,
  RECOVERY_MEMBER,
  expectBrowserRoute,
  fetchMeWithCookie,
  readControlApiMetrics,
  readLogoutFence,
  sessionCookieValue,
  signInThroughUi,
} from './journeys'

test('J2 recovery link clears the logout fence, revokes the prior session, and leads to login', async ({
  page,
}) => {
  // E2E_GUARDIAN_NAVIGATION: root-entry — the ordinary login that owns the prior session
  await page.goto('/')
  await signInThroughUi(page, RECOVERY_MEMBER.email, RECOVERY_MEMBER.password)
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(
    page.getByRole('heading', { name: 'Welcome, Synthetic Recovery Member' })
  ).toBeVisible()

  const priorSession = await sessionCookieValue(page)
  expect(priorSession).toBeTruthy()
  if (!priorSession) throw new Error('login did not set a profile session')
  const validBefore = await fetchMeWithCookie(page, priorSession)
  expect(validBefore.status).toBe(200)
  expect(validBefore.body).toMatchObject({ id: RECOVERY_MEMBER.id })

  await page.route('**/api/v1/auth/logout', route => route.abort('failed'))
  await test.step('logout fence precondition: unconfirmed logout leaves the recovery fence', async () => {
    await page.locator('aside').getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect.poll(() => readLogoutFence(page)).toBe('true')
    // The aborted logout never revoked the server-side session or cleared the
    // cookie, which is exactly the state the recovery link must recover from.
    expect(await sessionCookieValue(page)).toBe(priorSession)
  })
  await page.unroute('**/api/v1/auth/logout')
  const stillValidAfterLogout = await fetchMeWithCookie(page, priorSession)
  expect(stillValidAfterLogout.status).toBe(200)

  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — the synthetic emailed recovery link
  await page.goto('/invitations/synthetic-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()

  // Opening the link is only a stale preview, not an authoritative recovery
  // result. The fence must survive even when the browser clock says the link
  // is current; the reset submission itself is allowed through the fence.
  await expect(page.getByRole('button', { name: 'Reset password' })).toBeVisible()
  expect(await readLogoutFence(page)).toBe('true')

  await page.getByLabel('Password', { exact: true }).fill(RECOVERY_MEMBER.replacementPassword)
  await page.getByLabel('Confirm password').fill(RECOVERY_MEMBER.replacementPassword)
  const resetResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/password-reset') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Reset password' }).click()
  const resetResult = await resetResponse
  expect(resetResult.status()).toBe(200)

  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible()
  // The server accepted the recovery action: only now may the fence go.
  await expect.poll(() => readLogoutFence(page)).toBeNull()
  expect(await sessionCookieValue(page)).toBeNull()

  const revoked = await fetchMeWithCookie(page, priorSession)
  expect(revoked.status).toBe(401)

  // The password-updated screen is component state. A direct entry through the
  // recovery URL must still offer a usable forward action.
  await page.reload()
  await expectBrowserRoute(page, { pathname: '/invitations/synthetic-reset-proof' })
  await expect(
    page.getByText('This invitation has already been used.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Request a new recovery link' })).toBeVisible()

  await page.getByRole('link', { name: 'Sign in' }).click()
  await expectBrowserRoute(page, {
    pathname: '/',
    query: { email: RECOVERY_MEMBER.email },
  })
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(RECOVERY_MEMBER.email)
  await signInThroughUi(page, RECOVERY_MEMBER.email, RECOVERY_MEMBER.replacementPassword)

  await expectBrowserRoute(page, {
    pathname: '/',
    query: { email: RECOVERY_MEMBER.email },
  })
  await expect(
    page.getByRole('heading', { name: 'Welcome, Synthetic Recovery Member' })
  ).toBeVisible()
  const freshSession = await sessionCookieValue(page)
  expect(freshSession).toBeTruthy()
  if (!freshSession) throw new Error('fresh login did not set a profile session')
  expect(freshSession).not.toBe(priorSession)
  const validAfter = await fetchMeWithCookie(page, freshSession)
  expect(validAfter.status).toBe(200)
  expect(validAfter.body).toMatchObject({ id: RECOVERY_MEMBER.id })

  const metrics = await readControlApiMetrics(page)
  expect(metrics.passwordUpdates).toContainEqual({
    userId: RECOVERY_MEMBER.id,
    invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  })
  expect(metrics.meRequests).toContainEqual({ userId: RECOVERY_MEMBER.id })
  expect(metrics.loginSuccesses.filter(entry => entry.userId === RECOVERY_MEMBER.id)).toHaveLength(
    2
  )
})

test('J2 a redeemed recovery link keeps the logout fence over a live session', async ({ page }) => {
  // E2E_GUARDIAN_NAVIGATION: root-entry — the ordinary login that owns the live session
  await page.goto('/')
  await signInThroughUi(page, LOGOUT_MEMBER.email, LOGOUT_MEMBER.password)
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(
    page.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })
  ).toBeVisible()

  const liveSession = await sessionCookieValue(page)
  expect(liveSession).toBeTruthy()
  if (!liveSession) throw new Error('login did not set a profile session')
  const validBefore = await fetchMeWithCookie(page, liveSession)
  expect(validBefore.status).toBe(200)
  expect(validBefore.body).toMatchObject({ id: LOGOUT_MEMBER.id })

  await page.route('**/api/v1/auth/logout', route => route.abort('failed'))
  await test.step('logout fence precondition: unconfirmed logout leaves the recovery fence', async () => {
    await page.locator('aside').getByRole('button', { name: 'Log out' }).click()
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
    await expect.poll(() => readLogoutFence(page)).toBe('true')
    expect(await sessionCookieValue(page)).toBe(liveSession)
  })
  await page.unroute('**/api/v1/auth/logout')

  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — a redeemed recovery link cannot release the fence
  await page.goto('/invitations/synthetic-used-reset-proof')
  await expect(
    page.getByText('This invitation has already been used.', { exact: true })
  ).toBeVisible()
  expect(await readLogoutFence(page)).toBe('true')
  expect(await sessionCookieValue(page)).toBe(liveSession)
  const stillValid = await fetchMeWithCookie(page, liveSession)
  expect(stillValid.status).toBe(200)

  // The fence still blocks the surviving cookie from resuming the session.
  // E2E_GUARDIAN_NAVIGATION: root-entry — the fenced live session stays at login
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expectBrowserRoute(page, { pathname: '/' })
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })).toHaveCount(
    0
  )
  expect(await readLogoutFence(page)).toBe('true')

  // A current pending preview is still only a page view. It must not release
  // the fence: a stale snapshot plus a slow browser clock would otherwise let
  // the surviving session resume without a server decision. The other J2 test
  // proves release after the server accepts the reset.
  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — a pending preview does not release the fence
  await page.goto('/invitations/synthetic-pending-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Reset password' })).toBeVisible()
  expect(await readLogoutFence(page)).toBe('true')
})
