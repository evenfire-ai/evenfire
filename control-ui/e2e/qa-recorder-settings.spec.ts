import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only journey: sign in, open the Settings page from the sidebar, and
// assert the page shell renders. No setting is changed.
test.describe('optional QA recorder: Control UI settings journey', () => {
  test('records login and the read-only settings page journey', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // The sidebar 'Settings' link points at /settings/ui (CONTROL_ROUTES.settings.ui).
    // next.config.js rewrites /settings/ui -> /settings transparently, so the
    // browser URL stays /settings/ui while the app/settings/page.tsx shell renders.
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/ui/, { timeout: 20_000 })

    // Assert the settings page shell. TablePanelHeader renders the title in a
    // <span> (not a heading), so anchor on the unique subtitle + section titles,
    // which render regardless of the account data loading/empty/error state.
    await expect(page.getByText('Manage your Control UI admin account and theme.')).toBeVisible({
      timeout: 20_000,
    })
    await expect(page.getByText('Account info', { exact: true })).toBeVisible()
    await expect(page.getByText('Appearance', { exact: true })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible()

    await screenshotAndLog(page, testInfo, 'control-ui-settings')
  })
})
