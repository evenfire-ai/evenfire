import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openSettings,
  requireRecorderConfirm,
  screenshotAndLog,
  visitSettingsTab,
} from './qa-recorder-helpers'

// Optional QA recorder journey: Settings appearance, notifications, and configuration.
//
// Read-only by default. The only mutating step — exercising the desktop endpoint
// switcher (which logs out) — runs exclusively when QA_RECORDER_CONFIRM_MUTATIONS=1.
// The appearance theme toggle and the notification volume adjust are local
// preference/audio changes (no server or paid-provider call), so they run as part
// of the always-on read-only journey without a confirm flag.

test('optional QA recorder: Desktop settings journey — appearance and notifications', async ({}, testInfo) => {
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
    await openSettings(page)

    // (1) Appearance — assert the Theme panel rendered, then toggle the color mode
    // if the radio controls are present and confirm the shell still renders.
    await visitSettingsTab(page, 'Appearance', 'Theme')
    await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    const themeRadios = page.locator('input[name="settings-theme-mode"]')
    const themeRadioCount = await themeRadios.count()
    if (themeRadioCount >= 2) {
      const currentTheme = await page
        .evaluate(() => document.documentElement.getAttribute('data-theme'))
        .catch(() => null)
      // THEME_MODE_OPTIONS order is [{ dark }, { light }] -> dark=index 0, light=index 1.
      const targetIndex = currentTheme === 'dark' ? 1 : 0
      await themeRadios.nth(targetIndex).check({ force: true })
      await expect(page.getByTestId('nav-settings-menu')).toBeVisible({ timeout: 20_000 })
      // Best-effort restore so the recording leaves theme prefs stable.
      await themeRadios
        .nth(currentTheme === 'dark' ? 0 : 1)
        .check({ force: true })
        .catch(() => undefined)
    }

    await screenshotAndLog(page, testInfo, 'desktop-settings-appearance')

    // (2) Notifications — assert the In App Notifications panel rendered, then
    // adjust the alert volume via the number input if present and confirm no crash.
    await visitSettingsTab(page, 'Notifications', 'In App Notifications')
    await expect(
      page.getByRole('heading', { name: 'In App Notifications', exact: true })
    ).toBeVisible({ timeout: 20_000 })

    const volumeNumber = page.getByRole('spinbutton', {
      name: 'Notification sound volume percentage',
    })
    if (await volumeNumber.isVisible().catch(() => false)) {
      // fill() fires the local onChange only (no blur -> no preview sound).
      await volumeNumber.fill('40').catch(() => undefined)
    }
    // Assert the alert-volume surface still renders (no crash from the adjust).
    await expect(page.getByText('Alert volume').first()).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-settings-notifications')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop settings journey — information and configuration', async ({}, testInfo) => {
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
    await openSettings(page)

    // (3) Information / Configuration — assert the active endpoint and the app
    // version rows are shown (read-only). No data-testid current-version exists,
    // so assert on the rendered "External REST API URL" / "Desktop app version" rows.
    await visitSettingsTab(page, 'Information', 'External REST API URL')
    const panel = page.getByRole('tabpanel')
    await expect(panel.getByText('External REST API URL')).toBeVisible({ timeout: 20_000 })
    await expect(panel.getByText('Desktop app version')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-settings-information')

    // (4, OPTIONAL + gated) Exercise the desktop endpoint switcher surface, which
    // logs out to the AuthPage environment selector. Runs ONLY when opted in via
    // QA_RECORDER_CONFIRM_MUTATIONS=1; otherwise the read-only configuration view
    // above is the whole journey. The custom-endpoint form is exercised by filling
    // its fields and then going back — no destructive switch to an unknown host.
    if (process.env.QA_RECORDER_CONFIRM_MUTATIONS === '1') {
      requireRecorderConfirm(
        'QA_RECORDER_CONFIRM_MUTATIONS',
        'This step opens the desktop endpoint switcher and logs out.'
      )

      const settingsMenu = page.getByTestId('nav-settings-menu')
      if ((await settingsMenu.getAttribute('aria-expanded')) !== 'true') {
        await settingsMenu.click().catch(() => undefined)
      }
      const logoutBtn = page
        .getByTestId('logout-btn')
        .or(page.getByRole('button', { name: /^Logout$/ }))
      await expect(logoutBtn).toBeVisible({ timeout: 15_000 })
      await logoutBtn.click()

      // AuthPage rendered.
      await expect(page.locator('#email-input')).toBeVisible({ timeout: 20_000 })

      // Open the environment selector (the endpoint switch surface).
      const envToggle = page.getByRole('button', { name: 'Open environment selector' })
      await expect(envToggle).toBeVisible({ timeout: 20_000 })
      await envToggle.click()
      await expect(page.locator('#auth-runtime-dock-panel')).toBeVisible({ timeout: 15_000 })

      // Exercise the custom-endpoint form: add-environment, fill name + URL, then
      // cancel. No submit -> no persisted endpoint change.
      const addEnvBtn = page.getByRole('button', { name: 'Add environment' })
      if (await addEnvBtn.isVisible().catch(() => false)) {
        await addEnvBtn.click()
        const nameInput = page.locator('#runtime-config-name-input')
        const urlInput = page.locator('#runtime-config-external-rest-api-input')
        if (await nameInput.isVisible().catch(() => false)) {
          await nameInput.fill('QA recorder probe').catch(() => undefined)
        }
        if (await urlInput.isVisible().catch(() => false)) {
          await urlInput.fill(EXTERNAL_REST_API_BASE_URL).catch(() => undefined)
        }
        await page
          .getByRole('button', { name: /^Go back to login$/ })
          .click()
          .catch(() => undefined)
      }

      await screenshotAndLog(page, testInfo, 'desktop-settings-endpoint-switcher')
    } else {
      // eslint-disable-next-line no-console
      console.log(
        '[qa-recorder] Endpoint switch omitted (set QA_RECORDER_CONFIRM_MUTATIONS=1 to exercise it).'
      )
    }
  } finally {
    await finalizeRecording(app, page)
  }
})
