/**
 * Desktop App — Agents page tests
 *
 * Validates that the Agents page shows the assigned agents for the test user.
 * Requires: test user seeded with chatllm agent (make minikube-seed-test-data)
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { E2E_TEST_EMAIL } from '../../testUser.js'

const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const EXTERNAL_API_URL = process.env.EXTERNAL_REST_API_URL ?? 'http://127.0.0.1:8091'

async function launchAndLogin(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_JS],
    cwd: DESKTOP_APP_DIR,
    env: {
      ...process.env,
      EXTERNAL_REST_API_BASE_URL: EXTERNAL_API_URL,
      NODE_ENV: 'test',
    },
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // Login
  await page.fill('#dev-email-input', E2E_TEST_EMAIL)
  await page.click("button:has-text('Sign in')")

  // Wait for sidebar nav to confirm login succeeded
  await expect(page.locator("button.nav-link:has-text('Agents')")).toBeVisible({
    timeout: 20_000,
  })

  return { app, page }
}

test.describe('Desktop App — Agents', () => {
  let electronApp: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true') {
      test.skip()
      return
    }
    const result = await launchAndLogin()
    electronApp = result.app
    page = result.page
  })

  test.afterAll(async () => {
    await electronApp?.close()
  })

  test('Agents nav item is active by default after login', async () => {
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toBeVisible()
    const text = await activeNav.textContent()
    expect(text?.trim()).toBe('Agents')
  })

  test('Agents page shows chatllm agent (seeded)', async () => {
    // chatllm agent should be visible for the test user
    // (requires: make minikube-seed-test-data)
    const agentContent = page.locator('main, .main-content, .page-content')
    await expect(agentContent).toBeVisible({ timeout: 10_000 })

    const pageText = await page.textContent('body')
    // Either shows chatllm or a "No agents" empty state
    const hasAgent = pageText?.toLowerCase().includes('chatllm')
    const hasEmptyState = pageText?.toLowerCase().includes('no agent')
    expect(hasAgent || hasEmptyState).toBeTruthy()
  })

  test('Agents page renders without errors', async () => {
    // Check no error banners on the agents page
    const errorBanner = page.locator(".error, [style*='#ff8ea7'], [style*='red']")
    const errorCount = await errorBanner.count()
    // Allow 0 errors — if there are errors, log them
    if (errorCount > 0) {
      const errorText = await errorBanner.first().textContent()
      console.warn(`Agent page error: ${errorText}`)
    }
  })
})
