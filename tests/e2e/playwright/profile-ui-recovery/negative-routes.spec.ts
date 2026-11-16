import { expect, test } from '@playwright/test'
import {
  LOGOUT_MEMBER,
  readControlApiMetrics,
  sessionCookieValue,
  signInThroughUi,
} from './journeys'

test('negative routes show an explicit error and never issue a session', async ({
  page,
  browser,
}) => {
  // Same-observer witness: a real product login in an isolated context proves
  // this cookie observer sees product-issued sessions. It never seeds the
  // credentials or cookies used by the negative navigation below.
  const witnessContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  const witnessPage = await witnessContext.newPage()
  try {
    await witnessPage.goto('/')
    await signInThroughUi(witnessPage, LOGOUT_MEMBER.email, LOGOUT_MEMBER.password)
    await expect(
      witnessPage.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })
    ).toBeVisible()
    expect(await sessionCookieValue(witnessPage)).toBeTruthy()
  } finally {
    await witnessContext.close()
  }

  const before = await readControlApiMetrics(page)

  const expiredDocument = page.waitForResponse(response =>
    response.url().endsWith('/invitations/synthetic-expired-invitation')
  )
  // E2E_GUARDIAN_NAVIGATION: negative-route-guard — expired token is hidden by the authority
  await page.goto('/invitations/synthetic-expired-invitation')
  expect((await expiredDocument).status()).toBe(200)
  await expect(page.getByText('Invitation not found.', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  expect(await sessionCookieValue(page)).toBeNull()

  // E2E_GUARDIAN_NAVIGATION: negative-route-guard — a redeemed invitation stays visible as used
  await page.goto('/invitations/synthetic-used-invitation')
  await expect(
    page.getByText('This invitation has already been used.', { exact: true })
  ).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible()
  expect(await sessionCookieValue(page)).toBeNull()

  // E2E_GUARDIAN_NAVIGATION: negative-route-guard — an invented token does not resolve
  await page.goto('/invitations/synthetic-invented-token')
  await expect(page.getByText('Invalid invitation.', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  expect(await sessionCookieValue(page)).toBeNull()

  const after = await readControlApiMetrics(page)
  expect(after.passwordTokenRequests).toEqual(before.passwordTokenRequests)
  expect(after.loginSuccesses).toEqual(before.loginSuccesses)
  expect(after.invitations).toContainEqual(
    expect.objectContaining({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      purpose: 'member_invitation',
      status: 'accepted',
      passwordPending: false,
    })
  )
  expect(after.invitations).toContainEqual(
    expect.objectContaining({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      purpose: 'member_invitation',
      status: 'pending',
      passwordPending: true,
    })
  )
})

test('direct access to the authenticated home without login shows the login form', async ({
  page,
  browser,
}) => {
  // Same-observer witness: a real product login in an isolated context proves
  // this test's cookie observer sees product-issued sessions. It never seeds
  // the credentials or cookies used by the unauthenticated navigation below.
  const witnessContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  const witnessPage = await witnessContext.newPage()
  try {
    await witnessPage.goto('/')
    await signInThroughUi(witnessPage, LOGOUT_MEMBER.email, LOGOUT_MEMBER.password)
    await expect(
      witnessPage.getByRole('heading', { name: 'Welcome, Synthetic Logout Member' })
    ).toBeVisible()
    expect(await sessionCookieValue(witnessPage)).toBeTruthy()
  } finally {
    await witnessContext.close()
  }

  const homeSession = page.waitForResponse(
    response => response.url().endsWith('/api/v1/me') && response.request().method() === 'GET'
  )
  await page.goto('/')
  expect((await homeSession).status()).toBe(401)
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Welcome,/ })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Password updated' })).toHaveCount(0)
  expect(await sessionCookieValue(page)).toBeNull()

  const me = await page.request.get('/external-rest-api/api/v1/me')
  expect(me.status()).toBe(401)
})
