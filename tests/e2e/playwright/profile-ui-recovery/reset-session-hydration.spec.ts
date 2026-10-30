import { expect, test } from '@playwright/test'

const resetErrorCases = [
  {
    errorCode: 'invalid_password',
    status: 400,
    message: 'Password must be between 8 and 256 characters.',
  },
  {
    errorCode: 'invalid_invitation',
    status: 400,
    message: 'This recovery link is invalid or expired.',
  },
  { errorCode: 'forbidden', status: 403, message: 'Invitation email does not match.' },
  { errorCode: 'expired', status: 410, message: 'This invitation has expired.' },
  { errorCode: 'not_pending', status: 409, message: 'This invitation has already been used.' },
  {
    errorCode: 'rate_limited',
    status: 429,
    message: 'Account recovery is temporarily busy. Please wait a moment and try again.',
  },
  {
    errorCode: 'authority_unavailable',
    status: 503,
    message: 'Account recovery is temporarily unavailable. Please try again shortly.',
  },
  {
    errorCode: 'recovery_outcome_unknown',
    status: 503,
    message:
      'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.',
  },
  {
    errorCode: 'internal_error',
    status: 500,
    publicError: 'internal_error',
    state: 'editable',
    message: 'We could not update your password. Please try again.',
  },
  {
    errorCode: 'unknown_500',
    status: 503,
    publicError: 'recovery_outcome_unknown',
    state: 'ambiguous',
    message:
      'We could not confirm whether your password change completed. Try signing in with the new password. If that does not work, request a new reset link.',
  },
] as const

async function openRecovery(page: import('@playwright/test').Page) {
  // E2E_GUARDIAN_NAVIGATION: email-reset-entry — the synthetic emailed reset URL
  await page.goto('/invitations/synthetic-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()
}

test('retries session hydration after committed reset without resubmitting the reset proof', async ({
  page,
}) => {
  await openRecovery(page)

  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Recovery-Password-123')
  await page.getByLabel('Confirm password').fill('Synthetic-Recovery-Password-123')
  const resetResponsePromise = page.waitForResponse(
    response =>
      response.url().endsWith('/api/v1/invitations/password-reset') &&
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

test('trimmed-too-short password gets password guidance without dispatching a reset', async ({
  page,
}) => {
  await openRecovery(page)
  const before = await page.request
    .get('/external-rest-api/__test/metrics')
    .then(response => response.json())

  await page.getByLabel('Password', { exact: true }).fill('abcdefg ')
  await page.getByLabel('Confirm password').fill('abcdefg ')
  await page.getByRole('button', { name: 'Reset password' }).click()

  await expect(
    page.getByText('Password must be between 8 and 256 characters.', { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText('This recovery link is invalid or expired.', { exact: true })
  ).toHaveCount(0)
  const after = await page.request
    .get('/external-rest-api/__test/metrics')
    .then(response => response.json())
  expect(after.contractResetPosts).toBe(before.contractResetPosts)
  expect(after.resetPosts).toBe(before.resetPosts)
})

for (const failure of resetErrorCases) {
  test(`real reset route response ${failure.errorCode} reaches Profile UI apiSend`, async ({
    page,
  }) => {
    await openRecovery(page)
    const before = await page.request
      .get('/external-rest-api/__test/metrics')
      .then(response => response.json())

    const password = `Synthetic-Recovery-Contract-${failure.errorCode}-Password-123`
    await page.getByLabel('Password', { exact: true }).fill(password)
    await page.getByLabel('Confirm password').fill(password)
    const resetResponsePromise = page.waitForResponse(
      response =>
        response.url().endsWith('/api/v1/invitations/password-reset') &&
        response.request().method() === 'POST'
    )
    await page.getByRole('button', { name: 'Reset password' }).click()
    const resetResponse = await resetResponsePromise

    expect(resetResponse.status()).toBe(failure.status)
    expect(resetResponse.headers()['set-cookie']).toBeUndefined()
    if ('publicError' in failure) {
      expect(await resetResponse.json()).toMatchObject({ error: failure.publicError })
    }
    await expect(page.getByText(failure.message, { exact: true })).toBeVisible()
    await expect(
      page.getByText('This recovery link is invalid or expired.', { exact: true })
    ).toHaveCount(failure.errorCode === 'invalid_invitation' ? 1 : 0)

    const after = await page.request
      .get('/external-rest-api/__test/metrics')
      .then(response => response.json())
    expect(after.contractResetPosts).toBe(before.contractResetPosts + 1)
    expect(after.authenticatedMeReads).toBe(before.authenticatedMeReads)
    expect((await page.context().cookies()).some(cookie => cookie.name === 'profile_session')).toBe(
      false
    )
    if ('state' in failure && failure.state === 'editable') {
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
      await expect(page.getByLabel('Confirm password')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Reset password' })).toBeEnabled()
    }
    if ('state' in failure && failure.state === 'ambiguous') {
      await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
      await expect(page.getByRole('link', { name: 'Try signing in' })).toBeVisible()
      await expect(page.getByRole('link', { name: 'Request a new recovery link' })).toBeVisible()
    }
    await expect(page.getByText(/unclassified_failure|private detail/)).toHaveCount(0)
  })
}
