/**
 * Control UI — Authentication flow tests
 *
 * Tests the login/logout lifecycle of the Clerum Control UI.
 * Prerequisites: make minikube-pf-all
 */
import { expect, test } from '@playwright/test'
import { CUI_AUTH, CUI_DASHBOARD } from '../helpers/selectors'

const ADMIN_USERNAME = process.env.TEST_ADMIN_USERNAME ?? 'admin'
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD ?? 'changeme123!'

test.describe('Control UI — Auth', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('shows login form on initial load', async ({ page }) => {
    await expect(page.locator(CUI_AUTH.PAGE_HEADING)).toBeVisible()
    await expect(page.locator(CUI_AUTH.USERNAME_INPUT)).toBeVisible()
    await expect(page.locator(CUI_AUTH.PASSWORD_INPUT)).toBeVisible()
    await expect(page.locator(CUI_AUTH.SIGN_IN_BUTTON)).toBeVisible()
  })

  test('unauthenticated deep-link to a host detail page shows the login form, not host data', async ({
    page,
  }) => {
    // Negative route-guard: a direct visit to a protected entity route without
    // a session must land on the login form and must NOT leak host content.
    await page.goto('/hosts/chatllm')
    await expect(page.locator(CUI_AUTH.USERNAME_INPUT)).toBeVisible()
    await expect(page.locator(CUI_AUTH.SIGN_IN_BUTTON)).toBeVisible()
    await expect(page.getByText('Agent: chatllm')).toHaveCount(0)
  })

  test("shows 'Forgot my password' flow and returns to sign in", async ({ page }) => {
    // The login page toggles between 'login' and 'forgot-password' modes
    // (control-ui/app/page.tsx); the old "Account creation" tab is gone.
    await expect(page.locator(CUI_AUTH.FORGOT_PASSWORD_LINK)).toBeVisible()
    await page.click(CUI_AUTH.FORGOT_PASSWORD_LINK)
    // Password-reset form shows different fields
    await expect(page.locator(CUI_AUTH.RESET_USERNAME_INPUT)).toBeVisible()
    await expect(page.locator(CUI_AUTH.SEND_RESET_BUTTON)).toBeVisible()
    // Back to sign in
    await page.click(CUI_AUTH.BACK_TO_SIGN_IN_LINK)
    await expect(page.locator(CUI_AUTH.USERNAME_INPUT)).toBeVisible()
  })

  test('sign in button is disabled when fields are empty', async ({ page }) => {
    await expect(page.locator(CUI_AUTH.SIGN_IN_BUTTON)).toBeDisabled()
  })

  test('shows error on invalid credentials', async ({ page }) => {
    await page.fill(CUI_AUTH.USERNAME_INPUT, 'admin')
    await page.fill(CUI_AUTH.PASSWORD_INPUT, 'wrong-password-12345')
    await page.click(CUI_AUTH.SIGN_IN_BUTTON)
    await expect(page.locator(CUI_AUTH.ERROR_MESSAGE)).toBeVisible({
      timeout: 10_000,
    })
  })

  test('logs in with valid credentials and shows dashboard', async ({ page }) => {
    await page.fill(CUI_AUTH.USERNAME_INPUT, ADMIN_USERNAME)
    await page.fill(CUI_AUTH.PASSWORD_INPUT, ADMIN_PASSWORD)
    await page.click(CUI_AUTH.SIGN_IN_BUTTON)

    // Dashboard heading appears
    await expect(page.locator(CUI_DASHBOARD.HEADING)).toBeVisible({
      timeout: 15_000,
    })

    // All main tabs visible
    await expect(page.locator(CUI_DASHBOARD.TAB_AGENTS)).toBeVisible()
    await expect(page.locator(CUI_DASHBOARD.TAB_MARKETPLACE)).toBeVisible()
    await expect(page.locator(CUI_DASHBOARD.TAB_MCP_SERVERS)).toBeVisible()
    await expect(page.locator(CUI_DASHBOARD.TAB_CHANNELS)).toBeVisible()
    await expect(page.locator(CUI_DASHBOARD.TAB_MEMBERS_TEAMS)).toBeVisible()
  })

  test('login hint shows sign-in guidance without exposing a password', async ({ page }) => {
    // Wait for the auth page to fully render (React hydration)
    await page.locator(CUI_AUTH.USERNAME_INPUT).waitFor({ state: 'visible' })
    const pageText = await page.locator('main').textContent()
    expect(pageText).toContain('Sign in with your configured operator account')
    // Should NOT expose a hardcoded password like 'changeme123!' in the UI
    expect(pageText).not.toContain('changeme123!')
    expect(pageText).not.toContain('clerum-admin-2026')
  })

  test('logs out and returns to login form', async ({ page }) => {
    // Login first
    await page.fill(CUI_AUTH.USERNAME_INPUT, ADMIN_USERNAME)
    await page.fill(CUI_AUTH.PASSWORD_INPUT, ADMIN_PASSWORD)
    await page.click(CUI_AUTH.SIGN_IN_BUTTON)
    await expect(page.locator(CUI_DASHBOARD.HEADING)).toBeVisible({
      timeout: 15_000,
    })

    // Logout
    await page.click(CUI_DASHBOARD.LOGOUT_BUTTON)
    await expect(page.locator(CUI_AUTH.PAGE_HEADING)).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator(CUI_AUTH.USERNAME_INPUT)).toBeVisible()
  })
})
