// desktop-app/test/e2e-playwright/auth.test.ts
import { expect, test } from './fixtures.js'

test('1. login flow shows user name after login', async ({ appPage }) => {
  // appPage fixture already logged in — just verify
  const displayName = appPage.locator('[data-testid="user-display-name"]')
  await expect(displayName).toBeVisible()
  const text = await displayName.textContent()
  expect(text).toBeTruthy()
})
