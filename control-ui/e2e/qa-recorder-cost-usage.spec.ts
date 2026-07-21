// control-ui/e2e/qa-recorder-cost-usage.spec.ts
//
// Optional headful QA recorder journey for the Control UI "Cost & Usage" ->
// "Usage" dashboard. Read-only: navigates through the sidebar, asserts the
// dashboard shell renders, and exercises one filter change to prove the
// dashboard is wired up. Creates no cluster resources.
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder"). The headful Chromium, viewport, slowMo, and video recording are
// all managed by playwright.qa-recorder.config.ts via the built-in `page`
// fixture — this spec never launches a browser itself.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI cost and usage journey', () => {
  test('optional QA recorder: Control UI cost and usage dashboard journey', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // "Cost & Usage" is an expandable sidebar group rendered as a <button>
    // (its children — LLM Prices, Token Budgets, Usage — only enter the DOM
    // when the group is expanded). After login we land on /agents, so the
    // group starts collapsed; expand it, guarding on aria-expanded so this
    // stays resilient if the group is already open.
    const costToggle = page.getByRole('button', { name: 'Cost & Usage', exact: true })
    await expect(costToggle).toBeVisible({ timeout: 20_000 })
    if ((await costToggle.getAttribute('aria-expanded')) !== 'true') {
      await costToggle.click()
    }

    const usageLink = page.getByRole('link', { name: 'Usage', exact: true })
    await expect(usageLink).toBeVisible({ timeout: 20_000 })
    await usageLink.click()

    // The sidebar href is the canonical /cost-and-usage/usage (next.config.js
    // rewrites it to /cost/usage internally; the browser URL stays canonical),
    // so toHaveURL is safe and confirmed from the source.
    await expect(page).toHaveURL(/\/cost-and-usage\/usage/, { timeout: 20_000 })

    // Assert the dashboard shell. The TablePanelHeader title and subtitle
    // render immediately, regardless of how much usage data exists or whether
    // the chart is still loading — this is the resilient shell assertion.
    await expect(page.locator('.cu-panel-title').filter({ hasText: 'LLM Usage' })).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByText('Track token usage and request volume across LLM activity.')
    ).toBeVisible()

    // Dashboard chrome that always renders: the range + breakdown filters and
    // the time-series panel title. We intentionally do not assert on the chart
    // body or the "No usage in the selected range." empty state, since both
    // depend on live usage data.
    await expect(page.locator('#usage-range')).toBeVisible()
    await expect(page.locator('#usage-groupby')).toBeVisible()
    await expect(page.getByText('Tokens over time', { exact: true })).toBeVisible()

    // Read-only filter change to show the dashboard is interactive. Selecting
    // by <option> value (not human label text) keeps this resilient to label
    // copy changes.
    await page.locator('#usage-range').selectOption('7d')
    await expect(page.locator('#usage-range')).toHaveValue('7d')

    await screenshotAndLog(page, testInfo, 'control-ui-cost-usage')
  })
})
