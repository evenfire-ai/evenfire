import { type ElectronApplication, type Page, expect, test } from '@playwright/test'
import {
  EXTERNAL_REST_API_BASE_URL,
  RPC_PROXY_BASE_URL,
  assertAllowedTarget,
  desktopCredentials,
  finalizeRecording,
  launchDesktopApp,
  login,
  screenshotAndLog,
} from './qa-recorder-helpers'

// Read-only journey: exercises the AppHeader notification bell / inbox panel and
// the header global search. Neither test writes, messages, pays, or
// approves/denies anything — so no confirmation flag is required. Both still
// assert the loopback + health guard at the top, per the recorder contract.
//
// Selectors below come from desktop-app/ui/src/components/AppHeader/index.tsx:
//   - notification-bell IconButton -> opens role="dialog" "Notifications and approvals"
//   - inbox rows: data-testid="notification-menu-item" and "workflow-approval-card"
//   - empty inbox: ".notification-menu-empty" ("No notifications or pending approvals right now.")
//   - global search: TextInput aria-label="Search" -> results in ".global-search-results"
//   - no results: ".search-results-empty"; loading: ".search-results-loading"
// We deliberately do NOT click Approve/Deny (those mutate the backend).

test('optional QA recorder: Desktop inbox and search journey — inbox', async ({}, testInfo) => {
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

    // AppHeader is rendered for every authenticated view, so the bell is
    // always present after sign-in.
    const bell = page!.getByTestId('notification-bell')
    await expect(bell).toBeVisible({ timeout: 20_000 })

    // Opening the inbox must not throw; assert the dialog renders.
    await bell.click()
    await expect(bell).toHaveAttribute('aria-expanded', 'true', { timeout: 20_000 })

    const inboxDialog = page!.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(inboxDialog).toBeVisible({ timeout: 20_000 })

    // Resilient to empty / populated inbox: at least one row OR the empty
    // state must render. We never assert a specific seeded notification and
    // never touch the Approve/Deny buttons.
    const inboxRow = page!.getByTestId('notification-menu-item').first()
    const approvalCard = page!.getByTestId('workflow-approval-card').first()
    const emptyInbox = page!.getByText('No notifications or pending approvals right now.')
    await expect(inboxRow.or(approvalCard).or(emptyInbox)).toBeVisible({ timeout: 20_000 })

    // Close the inbox cleanly so the final screenshot shows the resting shell.
    await bell.click()
    await expect(bell).toHaveAttribute('aria-expanded', 'false', { timeout: 20_000 })

    await screenshotAndLog(page!, testInfo, 'desktop-inbox')
  } finally {
    await finalizeRecording(app, page)
  }
})

test('optional QA recorder: Desktop inbox and search journey — global search', async ({}, testInfo) => {
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

    const searchInput = page!.getByRole('textbox', { name: 'Search' })
    await expect(searchInput).toBeVisible({ timeout: 20_000 })

    // Known fixture term (agent "chatllm" / context "development" exist for
    // the QA user). Resilient: a result row OR the no-results OR the loading
    // state must render — we only assert the panel reaches a terminal state
    // without error, regardless of how much directory data has hydrated.
    await searchInput.fill('chatllm')
    const resultsPanel = page!.locator('.global-search-results')
    await expect(resultsPanel).toBeVisible({ timeout: 20_000 })
    const resultItem = page!.locator('.search-result-item').first()
    const noResults = page!.locator('.search-results-empty')
    const searchLoading = page!.locator('.search-results-loading')
    await expect(resultItem.or(noResults).or(searchLoading)).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page!, testInfo, 'desktop-global-search-known-term')

    // Nonsense term exercises the deterministic no-results branch. Accept the
    // transient loading state too, in case the team directory is still hydrating.
    await searchInput.fill('zzzznomatchqa')
    await expect(resultsPanel).toBeVisible({ timeout: 20_000 })
    await expect(noResults.or(searchLoading)).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page!, testInfo, 'desktop-global-search-no-results')
  } finally {
    await finalizeRecording(app, page)
  }
})
