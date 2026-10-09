import { expect, test } from '@playwright/test'

test('retries session hydration after committed reset without resubmitting the reset proof', async ({
  page,
}) => {
  await page.goto('/invitations/synthetic-reset-proof')
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()

  await page.getByLabel('Password', { exact: true }).fill('Synthetic-Recovery-Password-123')
  await page.getByLabel('Confirm password').fill('Synthetic-Recovery-Password-123')
  await page.getByRole('button', { name: 'Reset password' }).click()

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

  await page.getByRole('button', { name: 'Retry account session check' }).click()
  await expect(page).toHaveURL(/\/$/)
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
