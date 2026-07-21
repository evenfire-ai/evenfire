import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only inventory/navigation journey for the Marketplace (registry catalog)
// and Plugins (installed workflow recipes) shells. The sidebar 'Marketplace'
// link (href /marketplace/connectors) is rewritten transparently to the
// /registry page (RegistryCatalog); 'Plugins' (href /plugins) is rewritten to
// /workflow-recipes (RecipesTab). Both rewrites keep the source URL in the
// address bar, so toHaveURL asserts the canonical sidebar href.
//
// Each page renders a TablePanelHeader whose title is a plain <span> (not a
// heading role), so the shell is asserted via the header subtitle (unique,
// unconditional text) plus a stable header control, which render regardless of
// data volume or empty/loading/error state.

test.describe('optional QA recorder: Control UI marketplace and plugins journey', () => {
  test('marketplace catalog shell renders for connectors', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.getByRole('link', { name: 'Marketplace', exact: true }).click()
    await expect(page).toHaveURL(/\/marketplace\/connectors$/)

    // Shell proof: the TablePanelHeader subtitle renders regardless of catalog
    // size, filters, or empty state.
    await expect(
      page.getByText('Discover and install connectors and plugins from the Marketplace.')
    ).toBeVisible({ timeout: 20_000 })

    // The Marketplace entry-type tablist (Connectors / Plugins) is part of the
    // shell. Scope to the named tablist so the locator is unambiguous.
    const entryTabs = page.getByRole('tablist', { name: 'Marketplace entry types' })
    await expect(entryTabs.getByRole('tab', { name: 'Connectors', exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(entryTabs.getByRole('tab', { name: 'Plugins', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-marketplace')
  })

  test('plugins catalog shell renders', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.getByRole('link', { name: 'Plugins', exact: true }).click()
    await expect(page).toHaveURL(/\/plugins$/)

    // Shell proof: the RecipesTab header subtitle renders whether or not any
    // plugin is installed (the empty state shows beneath it).
    await expect(
      page.getByText('Select a plugin to view status, run history, and actions.')
    ).toBeVisible({ timeout: 20_000 })

    // The header CTAs are always present on the Plugins shell (disabled only
    // during the very first load), so they are reliable shell markers.
    await expect(page.getByRole('button', { name: 'Install Plugin', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-plugins')
  })
})
