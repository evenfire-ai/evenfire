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
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible({
    timeout: 20_000,
  })
}

export async function loginDesktopVisible(page: Page): Promise<void> {
  await expect(page.getByLabel('Email')).toBeVisible({ timeout: 20_000 })
  await page.getByLabel('Email').fill(DESKTOP_EMAIL)
  await page.getByLabel('Password').fill(DESKTOP_PASSWORD)
  const login = page.waitForResponse(
    response =>
      response.url().includes('/api/v1/auth/password-login') &&
      response.request().method() === 'POST'
  )
  await page.getByRole('button', { name: 'Sign in' }).click()
  const response = await login
  expect(response.ok(), `visible Desktop login must succeed, got ${response.status()}`).toBe(true)
}
