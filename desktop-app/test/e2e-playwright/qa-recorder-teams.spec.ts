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

// Read-only journey: Resources -> Teams directory, then a team detail.
// No chat, no writes, no paid calls — so no confirm flag is required. The
// loopback + health guard still runs for both targets.
test('optional QA recorder: Desktop teams journey', async ({}, testInfo) => {
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
    await openResourcesNavItem(page, 'nav-teams')

    // (1) Teams directory shell renders.
    const teamsHeading = page.getByRole('heading', { name: 'Members & Teams', exact: true })
    await expect(teamsHeading).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.teams-board-card')).toBeVisible({ timeout: 20_000 })

    // The shell is proven as soon as ANY directory state renders. Wait for a
    // known fixture row OR an explicit empty / loading / error state. Resilient
    // to loading, empty, and error seeds — we only hard-assert on fixture
    // identities we know exist (dev team, The Golden Kingdom).
    const devTeamRow = page.locator('.da-table__row--clickable', { hasText: 'dev team' })
    const goldenRow = page.locator('.da-table__row--clickable', { hasText: 'The Golden Kingdom' })
    const emptyState = page.getByRole('heading', { name: 'No teams', exact: true })
    const loadingState = page.getByText('Fetching teams and members...')
    const errorBox = page.locator('.teams-board-card .composer-error')
    await expect(
      devTeamRow.or(goldenRow).or(emptyState).or(loadingState).or(errorBox).first()
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'desktop-teams-directory')

    // (2) Settle to a terminal state (rows / empty / error) — not the transient
    // loading state — before deciding whether a known fixture row is present to
    // open. Skip-with-success when no fixture row is present; the directory
    // shell assertions above already prove the journey for empty/error seeds.
    await expect(devTeamRow.or(goldenRow).or(emptyState).or(errorBox).first()).toBeVisible({
      timeout: 20_000,
    })

    const targetRow = (await devTeamRow.isVisible().catch(() => false))
      ? devTeamRow
      : (await goldenRow.isVisible().catch(() => false))
        ? goldenRow
        : null

    if (targetRow) {
      const targetName = targetRow === devTeamRow ? 'dev team' : 'The Golden Kingdom'

      // Click the team-name span (plain text) to avoid the member avatar
      // buttons in the Members cell, which stop propagation.
      await targetRow.locator('.team-list-name').click()

      // Detail shell + the team's own heading render.
      await expect(
        page.getByRole('heading', { name: targetName, exact: true, level: 3 })
      ).toBeVisible({ timeout: 20_000 })

      // The three detail tabs render (Members / Contexts / Agents).
      const tabsNav = page.locator('.team-tabs')
      await expect(tabsNav).toBeVisible({ timeout: 20_000 })
      await expect(tabsNav.getByRole('button', { name: 'Members', exact: true })).toBeVisible()
      await expect(tabsNav.getByRole('button', { name: 'Contexts', exact: true })).toBeVisible()
      await expect(tabsNav.getByRole('button', { name: 'Agents', exact: true })).toBeVisible()

      // Default tab is Members; its panel must render (member table or an
      // explicit "No members" empty state).
      await expect(page.locator('.team-resource-list').first()).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'desktop-team-detail')
    }
  } finally {
    await finalizeRecording(app, page)
  }
})
