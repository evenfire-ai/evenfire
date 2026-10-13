import { expect, test } from '@playwright/test'

test('retries session hydration after committed reset without resubmitting the reset proof', async ({
  page,
}) => {
  // E2E_GUARDIAN_EMAIL_RESET_ENTRY_POINT: the emailed password-reset URL.
  await page.goto('/invitations/synthetic-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()

  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Recovery-Password-123')
  await page.getByLabel('Confirm password').fill('Synthetic-Recovery-Password-123')
  const resetResponsePromise = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/password') &&
      response.request().method() === 'POST'
  )
  const firstSessionResponsePromise = page.waitForResponse(
    response => response.url().endsWith('/api/v1/me') && response.request().method() === 'GET'
  )
  await page.getByRole('button', { name: 'Reset password' }).click()

  const [resetResponse, firstSessionResponse] = await Promise.all([
    resetResponsePromise,
    firstSessionResponsePromise,
  ])
  expect(resetResponse.status()).toBe(200)
  expect(firstSessionResponse.status()).toBe(404)
  expect(await firstSessionResponse.json()).toEqual({ error: 'User not found' })

  await expect(
    page.getByText(
      'Your password was updated, but we could not verify your account session. Try again.',
      { exact: true }
    )
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry account session check' })).toBeEnabled()
  await expect(page).not.toHaveURL(/\/$/)

  const beforeRetry = await page.request
    .get('/external-rest-api/__test/metrics')
    .then(response => response.json())
  expect(beforeRetry).toMatchObject({
    resetPosts: 1,
    authenticatedMeReads: 1,
    passwordChanged: true,
  })

  const retrySessionResponsePromise = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/me') &&
      response.request().method() === 'GET' &&
      response.status() === 200
  )
  await page.getByRole('button', { name: 'Retry account session check' }).click()
  const retrySessionResponse = await retrySessionResponsePromise
  expect(retrySessionResponse.status()).toBe(200)
  expect(await retrySessionResponse.json()).toMatchObject({
    id: 'synthetic-member-id',
    email: 'member@example.invalid',
  })
  await expect(page).toHaveURL(/\/$/)
  expect(new URL(page.url()).pathname).toBe('/')
  await expect(page.getByRole('heading', { name: 'Welcome, Synthetic Member' })).toBeVisible()
  await expect(page.getByText('member@example.invalid')).toBeVisible()

  const afterRetry = await page.request
    .get('/external-rest-api/__test/metrics')
    .then(response => response.json())
  expect(afterRetry).toMatchObject({
    resetPosts: 1,
    authenticatedMeReads: 2,
    passwordChanged: true,
  })
})
