import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only Control UI QA recorder journey for the Connectors inventory.
//
// The sidebar 'Connectors' link (components/Sidebar/constants.tsx) targets
// CONTROL_ROUTES.connectors.root (`/connectors`). There is no app/connectors
// page — next.config.js rewrites `/connectors` -> `/mcp-servers`, so the browser
// URL stays `/connectors` while app/mcp-servers/page.tsx renders <McpServerTable>.
// We assert the page shell (TablePanelHeader subtitle + panel title), which
// renders identically for the loading, populated, and empty states, then
// best-effort open the first connector row when one is present.

test.describe('optional QA recorder: Control UI connectors journey', () => {
  test('records login and the connectors inventory page', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()

    // The rewrite keeps the URL on /connectors; assert it landed.
    await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })

    // Shell proof: the TablePanelHeader subtitle is unique and renders regardless of
    // whether the inventory is loading, populated, or empty.
    await expect(
      page.getByText('Browse connector deployments and context bindings.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    // Panel title is "Connectors" while loading/empty, or "Connectors (N)" once populated.
    await expect(page.locator('.cu-panel-title').filter({ hasText: /^Connectors/ })).toBeVisible()

    // Best-effort: if at least one connector rendered, use its row menu to open the
    // dedicated detail/edit screen. Guarded so the journey still passes when empty.
    const actions = page.getByRole('button', { name: /^Actions for connector / }).first()
    if (await actions.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await actions.click()
      await page.getByRole('menuitem', { name: 'View details' }).click()
      await expect(page.getByRole('heading', { name: /^Edit Connector:/ })).toBeVisible({
        timeout: 10_000,
      })
    }

    await screenshotAndLog(page, testInfo, 'control-ui-connectors')
  })
})
