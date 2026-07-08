/**
 * Desktop App — Navigation tests
 *
 * Validates the sidebar navigation between all pages after login.
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
  await page.fill('#dev-email-input', E2E_TEST_EMAIL)
  await page.click("button:has-text('Sign in')")
  await expect(page.locator("button.nav-link:has-text('Agents')")).toBeVisible({
    timeout: 20_000,
  })

  return { app, page }
}

test.describe('Desktop App — Navigation', () => {
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

  test('can navigate to Contexts', async () => {
    await page.click("button.nav-link:has-text('Contexts')")
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toHaveText('Contexts')
    // Content area should update
    await expect(page.locator('main, .main-content, .page-content')).toBeVisible()
  })

  test('can navigate to Teams', async () => {
    await page.click("button.nav-link:has-text('Teams')")
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toHaveText('Teams')
    await expect(page.locator('main, .main-content, .page-content')).toBeVisible()
  })

  test('can navigate to MCP Servers', async () => {
    await page.click("button.nav-link:has-text('MCP Servers')")
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toHaveText('MCP Servers')
    await expect(page.locator('main, .main-content, .page-content')).toBeVisible()
  })

  test('can navigate to Recipes', async () => {
    await page.click("button.nav-link:has-text('Recipes')")
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toHaveText('Recipes')
    await expect(page.locator('main, .main-content, .page-content')).toBeVisible()
  })

  test('can navigate back to Agents', async () => {
    // Navigate away first
    await page.click("button.nav-link:has-text('Teams')")
    // Then back to agents
    await page.click("button.nav-link:has-text('Agents')")
    const activeNav = page.locator('button.nav-link.active')
    await expect(activeNav).toHaveText('Agents')
  })
})
