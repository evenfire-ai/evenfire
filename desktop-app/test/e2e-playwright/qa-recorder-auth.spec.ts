import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Optional QA recorder journey for the Desktop App auth + runtime session surface.
// Read-only against the UI (no chat, no workflow, no endpoint switch), so it needs
// no confirm flag — only the loopback target guard shared by every recorder test.
// Each test launches a fresh isolated profile, so the sign-in screen is the
// starting state and there is no carryover between tests.

test('optional QA recorder: Desktop auth and session journey — sign-in screen', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    // Wait for the boot splash / dependency + session checks to clear.
    await expect(page.locator('.boot-overlay')).toBeHidden({ timeout: 30_000 })

    const emailInput = page.locator('#email-input')
    const passwordInput = page.locator('#password-input')
    const signInButton = page.getByRole('button', { name: /^Sign in$/ })
    const settingsMenu = page.getByTestId('nav-settings-menu')

    // A returning user may be auto-authenticated from a cached keyring session
    // (keytar persists across the recorder's isolated user-data-dirs). If so, the
    // authenticated shell is shown instead of the sign-in form; log out through
    // the app to clear that session and reveal the real sign-in screen. This also
    // exercises the auto-login + logout paths. email-input and the settings menu
    // are mutually exclusive, so the .or() is strict-mode safe.
    await expect(emailInput.or(settingsMenu)).toBeVisible({ timeout: 30_000 })
    if (await settingsMenu.isVisible().catch(() => false)) {
      if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
        await settingsMenu.click()
      }
      await page.getByTestId('logout-btn').click()
    }

    // Sign-in screen rendered with its three fixtures.
    await expect(emailInput).toBeVisible({ timeout: 20_000 })
    await expect(passwordInput).toBeVisible()
    await expect(signInButton).toBeVisible()

    await screenshotAndLog(page, testInfo, 'desktop-auth-signin-screen')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop auth and session journey — authenticated shell', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)

    // Authenticated shell proof: the chat nav item OR the composer is visible.
    const navChat = page.getByTestId('nav-chat')
    const composer = page.getByRole('textbox', { name: 'Agent message composer' })
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(navChat.or(composer).or(settingsMenu).first()).toBeVisible({ timeout: 20_000 })

    // Reveal the footer Settings menu so the signed-in profile block renders.
    await expect(settingsMenu).toBeVisible({ timeout: 20_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')

    // The display name falls back to the email local-part when no profile name
    // is set. Assert the local-part is shown; if a profile name is set instead,
    // fall back to the profile email line so the exact QA identity is still proven.
    const displayName = page.getByTestId('user-display-name')
    await expect(displayName).toBeVisible({ timeout: 20_000 })
    const localPart = credentials.email.split('@')[0]
    const shown = (await displayName.textContent()) ?? ''
    if (!shown.toLowerCase().includes(localPart.toLowerCase())) {
      await expect(page.locator('.sidebar-settings-profile-email')).toContainText(credentials.email)
    }

    await screenshotAndLog(page, testInfo, 'desktop-auth-authenticated-shell')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop auth and session journey — logout', async ({}, testInfo) => {
  await assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  await assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)

    // Expand the footer Settings menu to reveal the logout menu item.
    const settingsMenu = page.getByTestId('nav-settings-menu')
    await expect(settingsMenu).toBeVisible({ timeout: 20_000 })
    if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
      await settingsMenu.click()
    }
    await expect(settingsMenu).toHaveAttribute('aria-expanded', 'true')

    const logoutButton = page.getByTestId('logout-btn')
    await expect(logoutButton).toBeVisible({ timeout: 20_000 })
    await logoutButton.click()

    // Signing out returns the user to the sign-in screen.
    await expect(page.locator('#email-input')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-auth-logout')
  } finally {
    await finalizeRecording(app, page)
  }
})
