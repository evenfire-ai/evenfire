import { expect, test } from '@playwright/test'
import {
  RECOVERY_MEMBER,
  fetchMeWithCookie,
  readControlApiMetrics,
  readLogoutFence,
  seedLogoutFence,
  sessionCookieValue,
  signInThroughUi,
} from './journeys'

test('J2 recovery link clears the logout fence, revokes the prior session, and leads to login', async ({
  page,
}) => {
  // E2E_GUARDIAN_NAVIGATION: root-entry — the ordinary login that owns the prior session
  await page.goto('/')
  await signInThroughUi(page, RECOVERY_MEMBER.email, RECOVERY_MEMBER.password)
  await expect(
    page.getByRole('heading', { name: 'Welcome, Synthetic Recovery Member' })
  ).toBeVisible()

  const priorSession = await sessionCookieValue(page)
  expect(priorSession).toBeTruthy()
  if (!priorSession) throw new Error('login did not set a profile session')
  const validBefore = await fetchMeWithCookie(page, priorSession)
  expect(validBefore.status).toBe(200)
  expect(validBefore.body).toMatchObject({ id: RECOVERY_MEMBER.id })

  await test.step('logout fence precondition: PROFILE_LOGOUT_UNCONFIRMED_KEY from a previous logout', async () => {
    await seedLogoutFence(page)
    expect(await readLogoutFence(page)).toBe('true')
  })

  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — the synthetic emailed recovery link
  await page.goto('/invitations/synthetic-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()

  // The recovery link must clear the fence before the form can reach the backend.
  await expect.poll(() => readLogoutFence(page)).toBeNull()

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
  expect(await sessionCookieValue(page)).toBeNull()

  const revoked = await fetchMeWithCookie(page, priorSession)
  expect(revoked.status).toBe(401)

  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue(RECOVERY_MEMBER.email)
  await signInThroughUi(page, RECOVERY_MEMBER.email, RECOVERY_MEMBER.replacementPassword)

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
