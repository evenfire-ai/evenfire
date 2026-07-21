import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only inventory/navigation journey for the Control UI Users & Teams
// directory. It signs in through the real UI, opens the members (users)
// directory from the sidebar, then switches to the teams list via the in-page
// tab navigation, asserting each page shell renders. It tolerates empty,
// loading, and error states by anchoring on the TablePanelHeader tablist and
// the per-tab primary CTA, both of which render regardless of data volume.

test.describe('optional QA recorder: Control UI users and teams journey', () => {
  test('records the users and teams directory navigation', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // Open the Users & Teams directory from the sidebar. The sidebar entry links
    // to the canonical /users-and-teams/users route (rewritten internally to
    // /profile-admin/users); the browser URL stays /users-and-teams/users.
    await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
    await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

    // Page shell: the Users & Teams tablist is unique to this page and renders
    // even while the member list is loading or empty.
    const sectionTabs = page.getByRole('tablist', { name: 'Users and teams sections' })
    await expect(sectionTabs).toBeVisible({ timeout: 20_000 })
    // The "Create member" CTA only renders on the members (users) tab.
    await expect(page.getByRole('button', { name: 'Create member', exact: true })).toBeVisible()

    // Switch to the teams list using the in-page tab navigation. While the
    // members tab is active the Teams tab is always labeled exactly "Teams"
    // (the count is only appended to the active tab). It is rendered as a
    // disabled button during initial load, so wait for it to become an enabled
    // link before clicking.
    const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
    await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
    await teamsTab.click()
    await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })

    // Teams page shell: the same tablist is present, and the "Create team" CTA
    // only renders on the teams tab.
    await expect(sectionTabs).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: 'Create team', exact: true })).toBeVisible()

    await screenshotAndLog(page, testInfo, 'control-ui-users-teams')
  })
})
