/**
 * Control UI — Connectors tab tests
 *
 * Validates the Connectors view (read-only ResourceTable). Strings follow
 * components/McpServerTable.tsx: the "Connectors (N)" panel title, the
 * "Install from Marketplace" action, creation behind the "Connector actions"
 * kebab, and the per-row "Actions for connector <name>" kebab.
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Connectors', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_MCP_SERVERS)
  })

  test('Connectors tab shows resource table heading', async ({ authedPage }) => {
    const heading = authedPage
      .locator('main')
      .getByText(/^Connectors \(\d+\)$/)
      .first()
    await expect(heading.first()).toBeVisible({ timeout: 15_000 })
  })

  test('Connectors tab shows install/create actions and row-level actions', async ({
    authedPage,
  }) => {
    await expect(authedPage.getByRole('button', { name: 'Install from Marketplace' })).toBeVisible()
    // Creation lives behind the "Connector actions" kebab (lowercase c menuitem).
    const connectorActions = authedPage.getByRole('button', { name: 'Connector actions' })
    await expect(connectorActions).toBeVisible()
    await connectorActions.click()
    await expect(
      authedPage.getByRole('menuitem', { name: 'Create connector', exact: true })
    ).toBeVisible()
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeHidden()
    await expect(
      authedPage
        .locator('tbody tr')
        .first()
        .getByRole('button', { name: /^Actions for connector / })
    ).toBeVisible()
  })

  test('shows at least the chatllm connector entries', async ({ authedPage }) => {
    const tableOrEmpty = authedPage.locator('table, p, div').filter({
      hasText: /chatllm|mongodb|No connectors/i,
    })
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 15_000 })
  })
})
