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

// Read-only journey: no requireRecorderConfirm flag. The loopback + health
// guard still runs for both targets at the top of the test.
test('optional QA recorder: Desktop connectors journey', async ({}, testInfo) => {
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

    // Resources -> Connectors inventory page (exact nav item, not first-available).
    await openResourcesNavItem(page, 'nav-mcp-servers')

    // (1) Page shell rendered.
    const heading = page.getByRole('heading', { name: 'Connectors', exact: true })
    await expect(heading).toBeVisible({ timeout: 20_000 })

    // The connectors inventory lives inside the board card; scope content
    // locators to it so transient toasts/sidebar markup cannot satisfy the
    // resilient chain. The McpServerHealthTable testids (mcp-health-table /
    // mcp-health-empty) are emitted by the per-agent workspace, not this page,
    // but are kept in the .or() so the assertion stays resilient to either
    // surface and degrades gracefully if the inventory shell changes shape.
    const boardCard = page.locator('.mcp-servers-board-card')
    const connectorsTable = boardCard.locator('.mcp-servers-data-table')
    const healthTable = page.getByTestId('mcp-health-table')
    const emptyHeading = boardCard
      .getByRole('heading', { name: 'No connectors', exact: true })
      .or(boardCard.getByRole('heading', { name: 'Loading', exact: true }))
    const healthEmpty = page.getByTestId('mcp-health-empty')
    const errorAlert = boardCard.locator('.composer-error')

    await expect(
      connectorsTable.or(healthTable).or(emptyHeading).or(healthEmpty).or(errorAlert)
    ).toBeVisible({ timeout: 20_000 })

    // (2) If the connectors table is present, assert its container rendered and
    // that it is the agent-centric (connector, agent) list: an "Agent" column,
    // and NO legacy "Context" / multi-chip "Agents" columns. Rows may be empty —
    // clicking a row deep-links to THAT agent's Connectors tab, but we don't
    // exercise navigation here (rows may be absent). We only assert the shell.
    if (await connectorsTable.isVisible().catch(() => false)) {
      await expect(connectorsTable).toBeVisible()
      await expect(
        connectorsTable.getByRole('columnheader', { name: 'Agent', exact: true })
      ).toBeVisible()
      await expect(
        connectorsTable.getByRole('columnheader', { name: 'Context', exact: true })
      ).toHaveCount(0)
      await expect(
        connectorsTable.getByRole('columnheader', { name: 'Agents', exact: true })
      ).toHaveCount(0)
    }

    // (3) Toggle health detail if a toggle is exposed on this surface, then
    // assert the page did not crash. The connectors inventory renders a static
    // table (no mcp-health-toggle); the toggle is honored opportunistically for
    // any surface that exposes it, and is a safe no-op here.
    const healthToggle = page.getByTestId('mcp-health-toggle')
    if (await healthToggle.isVisible().catch(() => false)) {
      await healthToggle.click()
      await expect(heading).toBeVisible({ timeout: 20_000 })
    }

    await screenshotAndLog(page, testInfo, 'desktop-connectors')
  } finally {
    await finalizeRecording(app, page)
  }
})
