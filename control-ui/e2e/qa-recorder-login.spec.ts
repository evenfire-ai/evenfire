import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only journey: it never creates or mutates cluster resources, so no
// requireRecorderConfirm(...) gate is required. Every test still guards the
// loopback/reachability contract for both the UI and the Control API proxy.
test.describe('optional QA recorder: Control UI login and authenticated shell journey', () => {
  test('sign-in page renders before authentication', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    // Fresh page, no loginThroughUi: assert the unauthenticated sign-in form.
    await page.goto(CONTROL_UI_URL)

    const signInButton = page.getByRole('button', { name: /^Sign in$/ })
    await expect(signInButton).toBeVisible({ timeout: 20_000 })

    const usernameField = page.getByLabel('Username or email')
    await expect(usernameField).toBeVisible({ timeout: 20_000 })

    const passwordField = page.getByLabel('Password')
    await expect(passwordField).toBeVisible({ timeout: 20_000 })

    // The submit button stays disabled until both fields are non-empty; here we
    // only assert it renders, not that it is enabled.
    await expect(signInButton).toBeVisible()

    await screenshotAndLog(page, testInfo, 'control-login-form')
  })

  test('signing in reveals the authenticated shell', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()

    // loginThroughUi fills Username/Password, clicks Sign in, and waits for the
    // 'Main sections' navigation to mount. It also dismisses "Remind me later".
    await loginThroughUi(page, credentials)

    await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
      timeout: 20_000,
    })

    // The 'Agents' sidebar link is the primary authenticated destination; it
    // renders inside the Main sections nav regardless of cluster inventory.
    const agentsLink = page.getByRole('link', { name: 'Agents', exact: true })
    await expect(agentsLink).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-authenticated-shell')
  })
})
