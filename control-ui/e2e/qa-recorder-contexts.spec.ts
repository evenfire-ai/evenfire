import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  type NamedResource,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  resourceName,
  screenshotAndLog,
} from './qa-recorder-helpers'

test.describe('optional QA recorder: Control UI contexts journey', () => {
  test('optional QA recorder: Control UI contexts list journey', async ({ page }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    await page.getByRole('link', { name: 'Contexts', exact: true }).click()
    await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })

    // List shell (TablePanelHeader subtitle) renders regardless of row count.
    await expect(
      page.getByText('Group connectors into reusable access scopes.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    // The title span reads "Contexts" during initial load and "Contexts (N)" once loaded;
    // either is a valid shell. Prefer a single concrete selector to avoid strict-mode matches.
    await expect(page.getByPlaceholder('Search contexts')).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-contexts')
  })

  test('optional QA recorder: Control UI context detail and tab journey', async ({
    page,
  }, testInfo) => {
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    await loginThroughUi(page, credentials)

    // Read the inventory through the Control UI proxy (admin session cookie) so the
    // detail step only runs when a real context exists. Resilient to empty environments.
    const { status, data } = await api<{ items?: NamedResource[] }>(
      page.request,
      'GET',
      '/api/v1/admin/contexts'
    )
    const contextNames = status === 200 ? (data.items ?? []).map(resourceName).filter(Boolean) : []
    test.skip(
      contextNames.length === 0,
      'No contexts available in this environment; skipping context detail journey.'
    )
    const contextName = contextNames[0]

    await page.getByRole('link', { name: 'Contexts', exact: true }).click()
    await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })
    await expect(
      page.getByText('Group connectors into reusable access scopes.', { exact: true })
    ).toBeVisible({ timeout: 20_000 })

    // Open the detail for a known context. onView routes to the connectors tab.
    await page.getByRole('row', { name: `Open context ${contextName}`, exact: true }).click()

    // Detail shell (CreatePageHeader): the <h2> title is the context name and the
    // subtitle is stable copy that renders once the context has loaded.
    await expect(page).toHaveURL(new RegExp(`/contexts/.+`), { timeout: 20_000 })
    await expect(page.getByRole('heading', { name: contextName, exact: true })).toBeVisible({
      timeout: 20_000,
    })
    await expect(
      page.getByText('Review details, manage connectors, agents, teams, and members.', {
        exact: true,
      })
    ).toBeVisible({ timeout: 20_000 })

    await screenshotAndLog(page, testInfo, 'control-ui-context-detail')

    // Exercise a tab switch (Connectors is the default landing tab). Clicking the
    // Agents tab navigates to /contexts/<name>/agents and renders its panel shell.
    const agentsTab = page.getByRole('tab', { name: 'Agents', exact: true })
    await expect(agentsTab).toBeVisible({ timeout: 20_000 })
    await agentsTab.click()
    await expect(page).toHaveURL(/\/contexts\/.+\/agents$/, { timeout: 20_000 })
    await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByText('Agents using this context.', { exact: true })).toBeVisible({
      timeout: 20_000,
    })

    await screenshotAndLog(page, testInfo, 'control-ui-context-detail-agents')
  })
})
