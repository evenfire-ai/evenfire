import { expect, test } from '@playwright/test'

async function readMetrics(page: import('@playwright/test').Page) {
  const response = await page.request.get('/external-rest-api/__test/metrics')
  expect(response.status()).toBe(200)
  return response.json()
}

test('member accepts the prepared invitation and establishes its own password', async ({
  page,
}) => {
  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — synthetic emailed invitation entry
  await page.goto('/invitations/synthetic-member-invitation')

  await expect(page.getByRole('heading', { name: 'Join Synthetic Member Team team' })).toBeVisible()
  await expect(page.getByText('member-onboarding@example.invalid', { exact: true })).toBeVisible()
  await expect(page.getByText('Synthetic Member Team', { exact: true })).toBeVisible()
  await expect(page.getByText('Participant', { exact: true })).toBeVisible()

  const acceptPromise = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/accept') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  const accepted = await acceptPromise
  expect(accepted.status()).toBe(200)
  await expect(
    page.getByText('Set your password to finish joining Synthetic Member Team.')
  ).toBeVisible()

  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Member-Onboarding-123')
  await page.getByLabel('Confirm password').fill('Synthetic-Member-Onboarding-123')
  const passwordResponsePromise = page.waitForResponse(
    response =>
      /\/api\/v1\/invitations\/password(?:-reset)?$/.test(response.url()) &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Set password and continue' }).click()
  const passwordResponse = await passwordResponsePromise
  expect(new URL(passwordResponse.url()).pathname).toBe(
    '/external-rest-api/api/v1/invitations/password'
  )
  expect(passwordResponse.status()).toBe(200)
  await expect(
    page.getByText('You are now registered to Synthetic Member Team.', { exact: true })
  ).toBeVisible()

  const cookies = await page.context().cookies()
  expect(cookies).toContainEqual(
    expect.objectContaining({ name: 'profile_session', httpOnly: true, sameSite: 'Lax' })
  )
  const identity = await page.evaluate(async () => {
    const response = await fetch('/external-rest-api/api/v1/me')
    return { status: response.status, body: await response.json() }
  })
  expect(identity).toMatchObject({
    status: 200,
    body: {
      id: 'synthetic-member-onboarding-user',
      email: 'member-onboarding@example.invalid',
      teamId: 'synthetic-member-team',
      role: 'member',
    },
  })

  const metrics = await readMetrics(page)
  expect(metrics.ordinary.operations.acceptanceRequests).toEqual([
    { id: 'synthetic-member-invitation-row', purpose: 'member_invitation' },
  ])
  expect(metrics.ordinary.operations.passwordRequests).toEqual([
    { id: 'synthetic-member-invitation-row', purpose: 'member_invitation' },
  ])
  expect(metrics.ordinary.operations.resetRequests).toEqual([])
  expect(metrics.ordinary.invitations).toContainEqual(
    expect.objectContaining({
      id: 'synthetic-member-invitation-row',
      purpose: 'member_invitation',
      status: 'accepted',
      userId: 'synthetic-member-onboarding-user',
      acceptedUserId: 'synthetic-member-onboarding-user',
      passwordPending: false,
      passwordMutationCount: 1,
    })
  )
})

test('accepted admin desktop invitation uses the token fallback without a prior session', async ({
  page,
}) => {
  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — synthetic emailed invitation entry
  await page.goto('/invitations/synthetic-admin-invitation')

  await expect(page.getByText('admin-onboarding@example.invalid', { exact: true })).toBeVisible()
  await expect(page.getByText('Leader', { exact: true })).toBeVisible()
  await expect(
    page.getByText('Set your password to finish joining Evenfire.', { exact: true })
  ).toBeVisible()
  expect(await page.context().cookies()).toEqual([])

  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Admin-Onboarding-123')
  await page.getByLabel('Confirm password').fill('Synthetic-Admin-Onboarding-123')
  const passwordResponsePromise = page.waitForResponse(
    response =>
      /\/api\/v1\/invitations\/password(?:-reset)?$/.test(response.url()) &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Set password and continue' }).click()
  const passwordResponse = await passwordResponsePromise
  expect(new URL(passwordResponse.url()).pathname).toBe(
    '/external-rest-api/api/v1/invitations/password'
  )
  expect(passwordResponse.status()).toBe(200)
  await expect(
    page.getByText('You are now registered with Evenfire.', { exact: true })
  ).toBeVisible()

  const identity = await page.evaluate(async () => {
    const response = await fetch('/external-rest-api/api/v1/me')
    return { status: response.status, body: await response.json() }
  })
  expect(identity).toMatchObject({
    status: 200,
    body: {
      id: 'synthetic-admin-onboarding-user',
      email: 'admin-onboarding@example.invalid',
      role: 'admin',
    },
  })

  const metrics = await readMetrics(page)
  expect(metrics.ordinary.operations.acceptanceRequests).toContainEqual({
    id: 'synthetic-admin-invitation-row',
    purpose: 'admin_desktop_access',
  })
  expect(metrics.ordinary.operations.passwordRequests).toContainEqual({
    id: 'synthetic-admin-invitation-row',
    purpose: 'admin_desktop_access',
  })
  expect(metrics.ordinary.operations.resetRequests).toEqual([])
  expect(metrics.ordinary.invitations).toContainEqual(
    expect.objectContaining({
      id: 'synthetic-admin-invitation-row',
      purpose: 'admin_desktop_access',
      status: 'accepted',
      userId: 'synthetic-admin-onboarding-user',
      acceptedUserId: 'synthetic-admin-onboarding-user',
      passwordPending: false,
      passwordMutationCount: 1,
    })
  )
})

test('reset-only producer rejects an ordinary invitation without creating a session', async ({
  page,
}) => {
  const before = await readMetrics(page)
  const response = await page.request.post('/external-rest-api/api/v1/invitations/password-reset', {
    data: {
      token: 'synthetic-wrong-purpose-invitation',
      email: 'wrong-purpose@example.invalid',
      invitationId: 'synthetic-wrong-purpose-invitation-row',
      password: 'Synthetic-Wrong-Purpose-123',
    },
  })

  expect(response.status()).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'invitation_not_pending' })
  expect(response.headers()['set-cookie']).toBeUndefined()
  expect(await page.context().cookies()).toEqual([])

  const after = await readMetrics(page)
  expect(after.ordinary.operations.passwordRequests).toEqual(
    before.ordinary.operations.passwordRequests
  )
  expect(after.ordinary.invitations).toContainEqual(
    expect.objectContaining({
      id: 'synthetic-wrong-purpose-invitation-row',
      purpose: 'member_invitation',
      status: 'pending',
      acceptedUserId: null,
      passwordPending: true,
      passwordMutationCount: 0,
    })
  )
  expect(after.ordinary.operations.resetRequests).toContainEqual({
    id: 'synthetic-wrong-purpose-invitation-row',
  })
})
