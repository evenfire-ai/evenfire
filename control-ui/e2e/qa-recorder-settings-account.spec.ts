// control-ui/e2e/qa-recorder-settings-account.spec.ts
//
// MUTATING QA recorder journey. Opt-in only: set QA_RECORDER_CONFIRM_MUTATIONS=1
// in .env.qa-recorder. Changes the logged-in admin's own username, flips the
// theme, and (if present) resets local alert overrides. Every mutation is
// reverted in finally so the account/theme/.env.qa-recorder stay valid across
// repeated runs.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI settings account', () => {
  test('records username edit, theme toggle, and reset alerts', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey edits the admin username, flips the theme, and may reset local alert overrides.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const tempUsername = uniqueE2EName('qa-recorder')
    let originalIsDark = true

    try {
      await loginThroughUi(page, credentials)
      await page.goto(`${CONTROL_UI_URL}/settings`)
      await expect(page.getByText('Manage your Control UI admin account and theme.')).toBeVisible({
        timeout: 20_000,
      })

      const usernameRow = page
        .locator('.cu-settings-section')
        .filter({ hasText: 'Account info' })
        .locator('.cu-settings-row')
        .filter({ hasText: 'Username' })

      await usernameRow.getByRole('button', { name: 'Edit', exact: true }).click()
      await usernameRow.getByLabel('Username').fill(tempUsername)
      await usernameRow.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.getByText('Username updated.', { exact: true })).toBeVisible()
      await expect(usernameRow.getByText(tempUsername, { exact: true })).toBeVisible()

      const themeGroup = page.getByRole('radiogroup', { name: 'Theme' })
      const darkRadio = themeGroup.locator('#settings-theme-dark')
      const lightRadio = themeGroup.locator('#settings-theme-light')
      await expect(darkRadio).toBeVisible({ timeout: 20_000 })
      originalIsDark = await darkRadio.isChecked()
      const targetRadio = originalIsDark ? lightRadio : darkRadio
      const targetValue = originalIsDark ? 'light' : 'dark'
      await targetRadio.click()
      await expect(themeGroup.locator(`#settings-theme-${targetValue}`)).toBeChecked()

      const resetButton = page.getByRole('button', { name: 'Reset', exact: true })
      if (
        await resetButton
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        await resetButton.first().click()
        const dialog = page.getByRole('alertdialog')
        await expect(dialog.getByRole('heading', { name: 'Reset alerts?' })).toBeVisible()
        await dialog.getByRole('button', { name: 'Reset alerts', exact: true }).click()
        await expect(page.getByText('Alerts reset.', { exact: true })).toBeVisible()
      } else {
        await expect(page.getByText('Reset Alerts', { exact: true })).toHaveCount(0)
      }

      await screenshotAndLog(page, testInfo, 'control-ui-settings-account')
    } finally {
      const usernameRow = page.locator('.cu-settings-row').filter({ hasText: 'Username' })
      await usernameRow
        .getByRole('button', { name: 'Edit', exact: true })
        .click()
        .catch(() => undefined)
      await usernameRow
        .getByLabel('Username')
        .fill(credentials.username)
        .catch(() => undefined)
      await usernameRow
        .getByRole('button', { name: 'Save', exact: true })
        .click()
        .catch(() => undefined)

      const currentIsDark = await page
        .getByRole('radiogroup', { name: 'Theme' })
        .locator('#settings-theme-dark')
        .isChecked()
        .catch(() => originalIsDark)
      if (currentIsDark !== originalIsDark) {
        const themeValue = originalIsDark ? 'dark' : 'light'
        await page
          .getByRole('radiogroup', { name: 'Theme' })
          .locator(`#settings-theme-${themeValue}`)
          .click()
          .catch(() => undefined)
      }
    }
  })
})
