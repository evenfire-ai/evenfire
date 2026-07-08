/**
 * Desktop App — Authentication flow tests
 *
 * Uses Playwright's _electron launcher to test the full Electron process.
 * Requires the app to be built: cd desktop-app && npm run build
 *
 * Prerequisites:
 *   make minikube-pf-desktop  (external-rest-api :8091, rpc-proxy :8094)
 *   cd desktop-app && npm run build
 */
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import path from 'path'
import { E2E_TEST_EMAIL } from '../../testUser.js'

const DESKTOP_APP_DIR = path.resolve(__dirname, '../../../../desktop-app')
const MAIN_JS = path.join(DESKTOP_APP_DIR, 'dist/main.js')
const EXTERNAL_API_URL = process.env.EXTERNAL_REST_API_URL ?? 'http://127.0.0.1:8091'

// Electron fixture — launches and closes the app for each test
async function launchApp(): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_JS],
    cwd: DESKTOP_APP_DIR,
    env: {
      ...process.env,
      EXTERNAL_REST_API_BASE_URL: EXTERNAL_API_URL,
      NODE_ENV: 'test',
    },
  })
}

test.describe('Desktop App — Auth', () => {
  let electronApp: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    if (process.env.PLAYWRIGHT_DESKTOP_BUILT !== 'true') {
      test.skip()
      return
    }
    electronApp = await launchApp()
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close()
  })

  test('shows Evenfire Desktop heading on launch', async () => {
    const heading = page.locator("h1:has-text('Evenfire Desktop')")
    await expect(heading).toBeVisible({ timeout: 15_000 })
  })

  test('shows descriptive subtitle about agents and MCP servers', async () => {
    const subtitle = page.locator('p.muted')
    await expect(subtitle).toBeVisible()
    const text = await subtitle.textContent()
    expect(text).toMatch(/agents|mcp|servers/i)
  })

  test('shows dev email input with correct placeholder', async () => {
    const emailInput = page.locator('#dev-email-input')
    await expect(emailInput).toBeVisible()
    const placeholder = await emailInput.getAttribute('placeholder')
    expect(placeholder).toBe('dev@clerum.io / test@clerum.io')
  })

  test('Sign in button is visible and initially enabled', async () => {
    const signInBtn = page.locator("button:has-text('Sign in')")
    await expect(signInBtn).toBeVisible()
  })

  test('can type email into input', async () => {
    const emailInput = page.locator('#dev-email-input')
    await emailInput.fill(E2E_TEST_EMAIL)
    await expect(emailInput).toHaveValue(E2E_TEST_EMAIL)
  })

  test('successful login shows sidebar navigation', async () => {
    const emailInput = page.locator('#dev-email-input')
    await emailInput.fill(E2E_TEST_EMAIL)
    await page.click("button:has-text('Sign in')")

    // After login, sidebar nav should appear with nav-link buttons
    const agentsNav = page.locator("button.nav-link:has-text('Agents')")
    await expect(agentsNav).toBeVisible({ timeout: 20_000 })

    // Verify all nav items are present
    await expect(page.locator("button.nav-link:has-text('Contexts')")).toBeVisible()
    await expect(page.locator("button.nav-link:has-text('Teams')")).toBeVisible()
    await expect(page.locator("button.nav-link:has-text('MCP Servers')")).toBeVisible()
    await expect(page.locator("button.nav-link:has-text('Recipes')")).toBeVisible()
  })
})
