// control-ui/e2e/qa-recorder-settings-password.spec.ts
//
// MUTATING QA recorder journey. Opt-in only: set QA_RECORDER_CONFIRM_MUTATIONS=1
// in .env.qa-recorder. Changes the logged-in admin's own password to a clearly
// temporary value, re-logs-in with it, then reverts the password BACK to the
// original from adminCredentials() in finally so .env.qa-recorder keeps working.
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

test.describe('optional QA recorder: Control UI settings password', () => {
  test('records change password and revert to original', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey changes the admin password to a temporary value, then reverts it in finally.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const tempPassword = `${uniqueE2EName('qa-recorder')}-temp!`

    try {
      await loginThroughUi(page, credentials)
      await page.goto(`${CONTROL_UI_URL}/settings`)
      await expect(page.getByText('Manage your Control UI admin account and theme.')).toBeVisible({
        timeout: 20_000,
      })

      await page.getByRole('button', { name: 'Change password', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Change password' })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await dialog.getByLabel('Current password').fill(credentials.password)
      await dialog.getByLabel('New password').fill(tempPassword)
      await dialog.getByLabel('Confirm new password').fill(tempPassword)
      await dialog.getByRole('button', { name: 'Save password', exact: true }).click()
      await expect(
        page.getByText('Password updated. Sign in again.', { exact: true })
      ).toBeVisible()
      await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible({
        timeout: 20_000,
      })

      await loginThroughUi(page, { username: credentials.username, password: tempPassword })
      await expect(page.getByRole('navigation', { name: 'Main sections' })).toBeVisible({
        timeout: 20_000,
      })

      await screenshotAndLog(page, testInfo, 'control-ui-settings-password')
    } finally {
      try {
        await page.goto(`${CONTROL_UI_URL}/settings`).catch(() => undefined)
        await page
          .getByRole('button', { name: 'Change password', exact: true })
          .click()
          .catch(() => undefined)
        const dialog = page.getByRole('dialog', { name: 'Change password' })
        await dialog
          .getByLabel('Current password')
          .fill(tempPassword)
          .catch(() => undefined)
        await dialog
          .getByLabel('New password')
          .fill(credentials.password)
          .catch(() => undefined)
        await dialog
          .getByLabel('Confirm new password')
          .fill(credentials.password)
          .catch(() => undefined)
        await dialog
          .getByRole('button', { name: 'Save password', exact: true })
          .click()
          .catch(() => undefined)
        await expect(
          page.getByText('Password updated. Sign in again.', { exact: true })
        ).toBeVisible({ timeout: 20_000 })
      } catch {
        // Best-effort revert: if any step fails the operator must re-set the
        // admin password manually before re-running (.env.qa-recorder is now stale).
      }
    }
  })
})
