/**
 * Control UI — Hosts tab tests
 *
 * Validates the Hosts table and Host Wizard UI.
 * Uses the authedPage fixture to bypass the login form.
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD, CUI_HOSTS } from '../helpers/selectors'

test.describe('Control UI — Hosts', () => {
  test.beforeEach(async ({ authedPage }) => {
    // Hosts tab is default — just wait for dashboard to load
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('Hosts tab is active by default', async ({ authedPage }) => {
    // The Hosts tab button should be visually active (darker background via inline style)
    const hostsTab = authedPage.locator(CUI_DASHBOARD.TAB_HOSTS)
    await expect(hostsTab).toBeVisible()
    // Tab button exists and we can see the Create Host button (only shown on Hosts tab)
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeVisible()
  })

  test('shows hosts table with expected columns', async ({ authedPage }) => {
    const table = authedPage.locator(CUI_HOSTS.TABLE)
    await expect(table).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.locator(CUI_HOSTS.TABLE_HEADER_NAME)).toBeVisible()
    await expect(authedPage.locator(CUI_HOSTS.TABLE_HEADER_NAMESPACE)).toBeVisible()
  })

  test('shows chatllm host from cluster', async ({ authedPage }) => {
    await expect(authedPage.locator('table')).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.getByRole('button', { name: /^chatllm$/ })).toBeVisible({
      timeout: 15_000,
    })
  })

  test('Create Host button opens wizard with Close button', async ({ authedPage }) => {
    await authedPage.click(CUI_DASHBOARD.CREATE_HOST_BUTTON)
    // HostWizard has no semantic h2 — detect it by the Close button it renders
    await expect(authedPage.locator(CUI_HOSTS.WIZARD_CLOSE_BUTTON)).toBeVisible({
      timeout: 10_000,
    })
  })

  test('wizard can be closed', async ({ authedPage }) => {
    await authedPage.click(CUI_DASHBOARD.CREATE_HOST_BUTTON)
    const closeBtn = authedPage.locator(CUI_HOSTS.WIZARD_CLOSE_BUTTON)
    await expect(closeBtn).toBeVisible({ timeout: 10_000 })
    await closeBtn.click()
    // After close, wizard Close button gone, dashboard still visible
    await expect(closeBtn).toBeHidden()
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('Refresh button reloads host data', async ({ authedPage }) => {
    const refreshBtn = authedPage.locator(CUI_DASHBOARD.REFRESH_BUTTON)
    await expect(refreshBtn).toBeVisible()
    await refreshBtn.click()
    // After refresh, table should still be present (data reloaded)
    await expect(authedPage.locator(CUI_HOSTS.TABLE)).toBeVisible({ timeout: 15_000 })
  })
})
