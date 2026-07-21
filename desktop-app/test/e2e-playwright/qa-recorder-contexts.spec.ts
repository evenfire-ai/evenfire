import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  openResourcesNavItem,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only journey: Resources -> Contexts list, then a context detail.
// No chat, no writes, no paid calls — so no confirm flag is required. The
// loopback + health guard still runs for both targets.
test('optional QA recorder: Desktop contexts list and detail journey', async ({}, testInfo) => {
  assertAllowedTarget('EXTERNAL_REST_API_BASE_URL', EXTERNAL_REST_API_BASE_URL)
  assertAllowedTarget('RPC_PROXY_BASE_URL', RPC_PROXY_BASE_URL)

  const credentials = desktopCredentials()
  let app: ElectronApplication | undefined
  let page: Page | undefined

  try {
    const launched = await launchDesktopApp(testInfo)
    app = launched.app
    page = launched.page

    await login(page, credentials)
    await openResourcesNavItem(page, 'nav-contexts')

    // (1) Contexts list shell renders.
    const contextsHeading = page.getByRole('heading', { name: 'Contexts', exact: true })
    await expect(contextsHeading).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.contexts-board-card')).toBeVisible({ timeout: 20_000 })

    // Wait for the list to resolve to a known fixture row OR an explicit
    // empty / error state. Resilient to loading, empty, and error seeds — we
    // only hard-assert on fixture identities we know exist.
    const devRow = page.getByRole('button', { name: 'Open context development' })
    const moneyRow = page.getByRole('button', { name: 'Open context moneymaking' })
    const emptyState = page.getByText('No contexts').first()
    const errorBox = page.locator('.contexts-board-card .composer-error')
    await expect(devRow.or(moneyRow).or(emptyState).or(errorBox).first()).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'desktop-contexts-list')

    // (2) Open a context detail using an exact known fixture (development
    // preferred, moneymaking as a still-exact fallback). Skip-with-success when
    // no fixture row is present — the list shell assertions above already prove
    // the journey for empty/error seeds.
    const targetRow = (await devRow.isVisible().catch(() => false))
      ? devRow
      : (await moneyRow.isVisible().catch(() => false))
        ? moneyRow
        : null

    if (targetRow) {
      const targetId = targetRow === devRow ? 'development' : 'moneymaking'
      await targetRow.click()

      // Detail shell + tabs nav render.
      const tabsNav = page.locator('nav.context-tabs')
      await expect(tabsNav).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: targetId, exact: true, level: 3 })
      ).toBeVisible({ timeout: 20_000 })

      // Default tab is Agents; its panel must render.
      await expect(tabsNav.getByRole('button', { name: 'Agents', exact: true })).toBeVisible()
      await expect(page.locator('.context-resource-list').first()).toBeVisible()

      // Exercise the remaining detail tabs. Each renders a .context-resource-list
      // panel (table or explicit empty state) regardless of how much is seeded.
      for (const tabName of ['Connectors', 'Teams', 'Members', 'Agent Files']) {
        const tab = tabsNav.getByRole('button', { name: tabName, exact: true })
        await expect(tab).toBeVisible()
        await tab.click()
        await expect(page.locator('.context-resource-list').first()).toBeVisible({
          timeout: 20_000,
        })
      }

      await screenshotAndLog(page, testInfo, 'desktop-contexts-detail')
    }
  } finally {
    await finalizeRecording(app, page)
  }
})
