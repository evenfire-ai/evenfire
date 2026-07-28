// control-ui/e2e/qa-recorder-settings-email.spec.ts
//
// MUTATING QA recorder journey (also sends a real confirmation email). Opt-in
// only: set QA_RECORDER_CONFIRM_MUTATIONS=1 in .env.qa-recorder. Changes the
// logged-in admin's own email to a disposable address, clicks Resend
// confirmation, then reverts the email BACK to the original captured address in
// finally so .env.qa-recorder keeps working.
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

test.describe('optional QA recorder: Control UI settings email', () => {
  test('records email change, resend confirmation, and revert', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey changes the admin email and sends a confirmation email, then reverts it in finally.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const tempEmail = `${uniqueE2EName('qa-recorder')}@example.test`
    let originalEmail = ''

    try {
      await loginThroughUi(page, credentials)
      await page.goto(`${CONTROL_UI_URL}/settings`)
      await expect(page.getByText('Manage your Control UI admin account and theme.')).toBeVisible({
        timeout: 20_000,
      })

      const emailRow = page
        .locator('.cu-settings-section')
        .filter({ hasText: 'Account info' })
        .locator('.cu-settings-row')
        .filter({ hasText: 'Email' })

      await expect(emailRow.getByText(/@/)).toBeVisible({ timeout: 20_000 })
      originalEmail = (await emailRow.getByText(/@/).first().textContent()) ?? ''

      await emailRow.getByRole('button', { name: 'Edit', exact: true }).click()
      await emailRow.getByLabel('Email').fill(tempEmail)
      await emailRow.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(
        page.getByText(`Confirmation pending for ${tempEmail}.`, { exact: true })
      ).toBeVisible()

      await emailRow.getByRole('button', { name: 'Resend confirmation', exact: true }).click()
      await expect(page.getByText('Confirmation email sent.', { exact: true })).toBeVisible()
      await expect(page.locator('.cu-banner--error')).toHaveCount(0)

      await screenshotAndLog(page, testInfo, 'control-ui-settings-email')
    } finally {
      const emailRow = page.locator('.cu-settings-row').filter({ hasText: 'Email' })
      await emailRow
        .getByRole('button', { name: 'Edit', exact: true })
        .click()
        .catch(() => undefined)
      await emailRow
        .getByLabel('Email')
        .fill(originalEmail)
        .catch(() => undefined)
      await emailRow
        .getByRole('button', { name: 'Save', exact: true })
        .click()
        .catch(() => undefined)
    }
  })
})
