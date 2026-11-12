import { expect, test } from '@playwright/test'
import {
  ONBOARDING_MEMBER,
  expectBrowserRoute,
  readControlApiMetrics,
  sessionCookieValue,
  signInThroughUi,
} from './journeys'

test('J1 invitation onboarding ends in guided sign-in and a real login', async ({ page }) => {
  const before = await readControlApiMetrics(page)
  expect(before.meRequests.filter(entry => entry.userId === ONBOARDING_MEMBER.id)).toEqual([])

  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — the synthetic emailed invitation link
  await page.goto('/invitations/synthetic-member-invitation')

  await expect(page.getByRole('heading', { name: 'Join Synthetic Member Team team' })).toBeVisible()
  await expect(page.getByText('onboarding-member@example.invalid', { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic Member Team', { exact: true })).toBeVisible()

  const acceptResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/accept') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  expect((await acceptResponse).status()).toBe(200)
  await expect(
    page.getByText('Set your password to finish joining Synthetic Member Team.')
  ).toBeVisible()

  // Acceptance still issues the invitation session. Setting the password must
  // end it, so the witness is a real cookie before this transition.
  expect(await sessionCookieValue(page)).toBeTruthy()

  await page.getByLabel('Password', { exact: true }).fill(ONBOARDING_MEMBER.password)
  await page.getByLabel('Confirm password').fill(ONBOARDING_MEMBER.password)
  const passwordResponse = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/password') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Set password and continue' }).click()
  const passwordResult = await passwordResponse
  expect(passwordResult.status()).toBe(200)

  await expect(page.getByRole('heading', { name: 'Password updated' })).toBeVisible()
  await expect(
    page.getByText('Your password has been updated. Sign in with your new password to continue.')
  ).toBeVisible()
  expect(await sessionCookieValue(page)).toBeNull()

  const afterPassword = await readControlApiMetrics(page)
  expect(afterPassword.passwordUpdates).toContainEqual({
    userId: ONBOARDING_MEMBER.id,
    invitationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  })
  expect(afterPassword.meRequests.filter(entry => entry.userId === ONBOARDING_MEMBER.id)).toEqual(
    []
  )

  const loginLink = page.getByRole('link', { name: 'Sign in' })
  await expect(loginLink).toHaveAttribute(
    'href',
    `/?email=${encodeURIComponent(ONBOARDING_MEMBER.email)}`
  )

  // The password-updated screen is component state. A direct entry through the
  // invitation URL must still show a usable forward action.
  await page.reload()
  await expectBrowserRoute(page, { pathname: '/invitations/synthetic-member-invitation' })
  await expect(
    page.getByText('This invitation has already been used.', { exact: true })
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    `/?email=${encodeURIComponent(ONBOARDING_MEMBER.email)}`
  )

  await loginLink.click()
  await expectBrowserRoute(page, {
    pathname: '/',
    query: { email: ONBOARDING_MEMBER.email },
  })
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(ONBOARDING_MEMBER.email)
  await signInThroughUi(page, ONBOARDING_MEMBER.email, ONBOARDING_MEMBER.password)

  await expectBrowserRoute(page, {
    pathname: '/',
    query: { email: ONBOARDING_MEMBER.email },
  })
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Member' })).toBeVisible()
  await expect(page.getByText('onboarding-member@example.invalid')).toBeVisible()

  const afterLogin = await readControlApiMetrics(page)
  expect(afterLogin.loginSuccesses).toContainEqual({ userId: ONBOARDING_MEMBER.id })
  expect(afterLogin.meRequests).toContainEqual({ userId: ONBOARDING_MEMBER.id })

  const identity = await page.evaluate(async () => {
    const response = await fetch('/external-rest-api/api/v1/me')
    return { status: response.status, body: await response.json() }
  })
  expect(identity).toMatchObject({
    status: 200,
    body: {
      id: ONBOARDING_MEMBER.id,
      email: ONBOARDING_MEMBER.email,
      teamId: ONBOARDING_MEMBER.teamId,
      role: 'member',
    },
  })
})
