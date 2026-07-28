// control-ui/e2e/qa-recorder-marketplace-browse.spec.ts
//
// Read-only Marketplace catalog browse journey: opens the connectors catalog,
// exercises search + category filter, switches to the Plugins tab, then probes
// the registry through the Control API and — when entries exist — opens the
// first entry detail and asserts its header, version, Install action, and
// kebab menu. Nothing is installed or mutated; no confirm flag or cleanup.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  screenshotAndLog,
} from './qa-recorder-helpers'

type RegistryEntrySummary = {
  name: string
  version: string
  status?: string
}

type RegistryEntryListResponse = { data?: RegistryEntrySummary[] }

test.describe('optional QA recorder: Control UI marketplace browse', () => {
  test('Marketplace catalog browse, search, filter, plugins tab, and first entry detail', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    await loginThroughUi(page, adminCredentials())

    await page.getByRole('link', { name: 'Marketplace', exact: true }).click()
    await expect(page).toHaveURL(/\/marketplace\/connectors$/)

    // Catalog shell: the TablePanelHeader subtitle and the entry-type tablist
    // render regardless of catalog size or empty/loading/error state.
    await expect(
      page.getByText('Discover and install connectors and plugins from the Marketplace.', {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 })
    const entryTabs = page.getByRole('tablist', { name: 'Marketplace entry types' })
    await expect(entryTabs.getByRole('tab', { name: 'Connectors', exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(entryTabs.getByRole('tab', { name: 'Plugins', exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Search: a query that matches nothing drives the result set to the empty
    // state (the catalog also shows it when entirely empty, so this is resilient
    // to stripped environments). Wait for initial load to release the input.
    const connectorsSearch = page.getByLabel('Search Marketplace connectors', { exact: true })
    await expect(connectorsSearch).toBeEnabled({ timeout: 20_000 })
    await connectorsSearch.fill('zzzz-no-such-entry')
    await expect(page.getByText('No entries match your filters.', { exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await connectorsSearch.clear()

    // Category filter is part of the shell toolbar.
    await expect(page.getByLabel('Filter by category', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Switch to the Plugins tab; the search input re-binds to plugins.
    await entryTabs.getByRole('tab', { name: 'Plugins', exact: true }).click()
    await expect(page).toHaveURL(/\/marketplace\/plugins$/)
    await expect(page.getByLabel('Search Marketplace plugins', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    // Probe the registry through the Control UI proxy (admin session cookie) so
    // the detail step only runs when a real entry exists. Mirrors the contexts
    // detail skip pattern.
    const { status, data } = await api<RegistryEntryListResponse>(
      page.request,
      'GET',
      '/api/v1/admin/registry/entries'
    )
    const entries = status === 200 ? (data.data ?? []) : []
    test.skip(
      entries.length === 0,
      'No Marketplace entries in this environment; skipping entry detail journey.'
    )

    // Prefer a published entry so the Install action is present; fall back to
    // the first entry otherwise (header + kebab still render).
    const published = entries.filter(entry => entry.status === 'published')
    const target = published.length > 0 ? published[0] : entries[0]
    const detailPath = `/marketplace/entries/${encodeURIComponent(target.name)}/${encodeURIComponent(
      target.version
    )}`
    await page.goto(detailPath)
    await expect(page).toHaveURL(new RegExp(`/marketplace/entries/.+/.+`), { timeout: 20_000 })

    // Detail header (CreatePageHeader): the h2 title is the entry name and the
    // subtitle starts with "v<version> ·".
    await expect(page.getByRole('heading', { name: target.name, exact: true })).toBeVisible({
      timeout: 20_000,
    })
    const versionPattern = new RegExp(`v${target.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `)
    await expect(page.getByText(versionPattern).first()).toBeVisible({ timeout: 20_000 })

    // Install action: "Install" when not installed, "Installed" (disabled) when
    // already installed. Only asserted for published entries, which render it.
    if (published.length > 0) {
      await expect(
        page
          .getByRole('button', { name: 'Install', exact: true })
          .or(page.getByRole('button', { name: 'Installed', exact: true }))
      ).toBeVisible({ timeout: 20_000 })
    }

    // Kebab actions menu is always present on a loaded entry detail.
    await expect(
      page.getByRole('button', { name: 'Marketplace entry actions', exact: true })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-marketplace-browse')
  })
})
