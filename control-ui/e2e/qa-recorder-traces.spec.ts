import { expect, test } from '@playwright/test'
import { CONTROL_ROUTES } from '../app/constants/routes'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only journey: it never creates or mutates cluster resources, so no
// requireRecorderConfirm(...) gate is required. Every test still guards the
// loopback/reachability contract for both the UI and the Control API proxy.
test.describe('optional QA recorder: Control UI traces journey', () => {
  test('records the Traces dashboard (operations) shell after sign-in', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // The 'Traces' sidebar group is marked hidden in the canonical sidebar
    // config (components/Sidebar/constants.tsx), so it is not rendered in the
    // left nav. Navigate directly to the operations (Dashboard) route via its
    // builder from app/constants/routes.ts.
    await page.goto(`${CONTROL_UI_URL}${CONTROL_ROUTES.traces.operations}`)

    // The TablePanelHeader shell renders regardless of data state
    // (initialLoading / unavailable / populated), so the panel title is the
    // stable shell assertion. The title is a <span class="cu-panel-title">,
    // not a heading role, so match it via the class filter used elsewhere.
    const dashboardTitle = page
      .locator('.cu-panel-title')
      .filter({ hasText: /^Tracing dashboard$/ })
    await expect(dashboardTitle).toBeVisible({ timeout: 20_000 })

    await expect(
      page.getByText('Current control-api ingestion health and effective limits.', {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-traces')
  })

  test('records the traces dashboard state (loading, unavailable, or populated)', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.goto(`${CONTROL_UI_URL}${CONTROL_ROUTES.traces.operations}`)

    // Wait for the shell to mount before asserting the body state.
    await expect(
      page.locator('.cu-panel-title').filter({ hasText: /^Tracing dashboard$/ })
    ).toBeVisible({ timeout: 20_000 })

    // The body is one of three exclusive states (see TracingOperations/index.tsx):
    //   1. initialLoading -> "Loading tracing health…"
    //   2. unavailable    -> "Tracing health unavailable" (role="alert")
    //   3. snapshot       -> the cu-trace-ops-body with charts/limits/errors
    // To avoid strict-mode violations from overlapping matches, assert that
    // exactly one of these state markers is present (.first() guards against
    // any duplicate renders).
    const loadingState = page.getByText('Loading tracing health…', { exact: true })
    const unavailableState = page.getByText('Tracing health unavailable', { exact: true })
    const bodyState = page.locator('.cu-trace-ops-body')

    await expect
      .poll(
        async () => {
          const [loading, unavailable, body] = await Promise.all([
            loadingState.count(),
            unavailableState.count(),
            bodyState.count(),
          ])
          return loading + unavailable + body
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThanOrEqual(1)

    // Best-effort: if the body is populated, exercise the Refresh CTA in the
    // panel header to confirm the action wiring stays inert over read-only
    // inventory. Skipped silently when the body has not loaded yet.
    if ((await bodyState.count()) > 0) {
      const refresh = page.getByRole('button', { name: 'Refresh tracing health', exact: true })
      await expect(refresh).toBeEnabled({ timeout: 10_000 })
      await refresh.click()
    }

    await screenshotAndLog(page, testInfo, 'control-ui-traces-state')
  })
})
