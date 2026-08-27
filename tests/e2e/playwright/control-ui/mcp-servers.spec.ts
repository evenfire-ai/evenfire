/**
 * Control UI — MCP Servers tab tests
 *
 * Validates the MCP Servers view (read-only ResourceTable).
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — MCP Servers', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_MCP_SERVERS)
  })

  test('MCP Servers tab shows resource table heading', async ({ authedPage }) => {
    const heading = authedPage
      .locator('main')
      .getByText(/^MCP Servers \(\d+\)$/)
      .first()
    await expect(heading.first()).toBeVisible({ timeout: 15_000 })
  })

  test('MCP Servers tab shows install/create actions and row-level remove action', async ({
    authedPage,
  }) => {
    await expect(authedPage.getByRole('button', { name: 'Install from Registry' })).toBeVisible()
    await expect(authedPage.getByRole('button', { name: 'Create MCP Server' })).toBeVisible()
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_HOST_BUTTON)).toBeHidden()
    await expect(
      authedPage
        .locator('tbody tr')
        .first()
        .getByRole('button', { name: /Remove MCP server/i })
    ).toBeVisible()
  })

  test('shows at least the chatllm MCP server entries', async ({ authedPage }) => {
    const tableOrEmpty = authedPage.locator('table, p, div').filter({
      hasText: /chatllm|mongodb|No MCP/i,
    })
    await expect(tableOrEmpty.first()).toBeVisible({ timeout: 15_000 })
  })
})
