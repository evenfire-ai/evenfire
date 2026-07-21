// control-ui/e2e/qa-recorder-agents.spec.ts
//
// Optional QA recorder journey for the Control UI Agents (Hosts) inventory.
// Read-only: navigates the sidebar 'Agents' destination, asserts the hosts list
// shell renders, and — when at least one host row is present — opens the detail
// page and asserts the detail shell plus the tablist. Falls back to the empty
// state when no agents exist. Uses the shared helpers from
// qa-recorder-helpers.ts and the built-in `page` fixture (the headful Chromium
// + video recording are managed by playwright.qa-recorder.config.ts).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the recorder").
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI agents', () => {
  test('optional QA recorder: Control UI agents journey', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // Navigate via the sidebar 'Agents' destination (routes to /agents, which
    // next.config rewrites to the /hosts page — so assert page CONTENT, not URL).
    await page.getByRole('link', { name: 'Agents', exact: true }).click()

    // List shell: HostTable's TablePanelHeader subtitle is a stable marker that
    // renders regardless of row count (initial load, populated, or empty).
    await expect(
      page.getByText('Manage available agents and their host mappings.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    // Wait for either a clickable host row or the empty state. HostTable renders
    // exactly one of these branches (never both), so .or() is safe here. During
    // initial load neither matches (skeleton rows use a different class).
    const rowOrEmpty = page
      .locator('tr.cu-table__row--clickable')
      .or(page.getByText('No agents found.', { exact: true }))
    await expect(rowOrEmpty.first()).toBeVisible({ timeout: 20_000 })

    const rowCount = await page.locator('tr.cu-table__row--clickable').count()
    if (rowCount > 0) {
      const firstRow = page.locator('tr.cu-table__row--clickable').first()
      const ariaLabel = (await firstRow.getAttribute('aria-label')) || ''
      const hostName = ariaLabel.replace(/^Open agent\s+/i, '').trim()

      // Open the detail page via the row's name link button.
      if (hostName) {
        await firstRow.getByRole('button', { name: hostName, exact: true }).click()
        await expect(
          page.getByRole('heading', { name: `Agent: ${hostName}`, exact: true })
        ).toBeVisible({ timeout: 20_000 })
      } else {
        await firstRow.click()
        await expect(page.getByRole('heading', { name: /^Agent:/ })).toBeVisible({
          timeout: 20_000,
        })
      }

      // Detail shell: the tablist and at least one tab heading render.
      await expect(page.getByRole('tablist', { name: 'Agent sections' })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('tab', { name: 'Overview', exact: true })).toBeVisible({
        timeout: 20_000,
      })
    } else {
      await expect(page.getByText('No agents found.', { exact: true })).toBeVisible()
    }

    await screenshotAndLog(page, testInfo, 'control-ui-agents')
  })
})
