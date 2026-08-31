import { type Page, expect } from '@playwright/test'

const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'
const DESKTOP_EMAIL =
  process.env.E2E_DEV_LOGIN_EMAIL ?? process.env.TEST_USER_EMAIL ?? 'test@clerum.io'
const DESKTOP_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'changeme123!'

export async function loginControlUiVisible(page: Page): Promise<void> {
  await expect(page.getByLabel('Username or email')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Username or email').fill(ADMIN_USERNAME)
  await page.getByLabel('Password').fill(ADMIN_PASSWORD)
  const login = page.waitForResponse(
    response =>
      response.url().includes('/api/v1/admin/auth/login') && response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  const response = await login
  expect(response.ok(), `visible Control UI login must succeed, got ${response.status()}`).toBe(
    true
  )
  await expect(page.getByLabel('Main navigation')).toBeVisible({
    timeout: 20_000,
  })
}

export async function loginDesktopVisible(page: Page): Promise<void> {
  await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 20_000 })
  const backToLogin = page.getByRole('button', { name: 'Go back to login' })
  if (await backToLogin.isVisible().catch(() => false)) {
    await backToLogin.click()
  }
  const email = page.locator('#email-input')
  await expect(email).toBeVisible({ timeout: 30_000 })
  await email.fill(DESKTOP_EMAIL)
  await page.locator('#password-input').fill(DESKTOP_PASSWORD)
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  // Desktop password-login is main-process IPC, not a renderer page response.
  await expect(page.getByTestId('nav-chat')).toBeVisible({ timeout: 30_000 })
}
