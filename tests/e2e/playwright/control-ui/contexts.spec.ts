/**
 * Control UI — Contexts tab tests
 *
 * Validates the Contexts table and navigation to context detail page.
 */
import { expect, test } from '../helpers/auth-fixture'
import { CUI_CONTEXTS, CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Contexts', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
    await authedPage.click(CUI_DASHBOARD.TAB_CONTEXTS)
  })

  test('Contexts tab shows table with correct columns', async ({ authedPage }) => {
    const table = authedPage.locator(CUI_CONTEXTS.TABLE)
    await expect(table).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.locator(CUI_CONTEXTS.TABLE_HEADER_NAME)).toBeVisible()
    await expect(authedPage.locator(CUI_CONTEXTS.TABLE_HEADER_MCP_SERVERS)).toBeVisible()
  })

  test('shows context1 from cluster', async ({ authedPage }) => {
    await expect(authedPage.locator('table')).toBeVisible({ timeout: 15_000 })
    const contextRow = authedPage.locator('tbody tr').filter({ hasText: 'context1' }).first()
    await expect(contextRow).toBeVisible({ timeout: 15_000 })
    await expect(contextRow.getByRole('button', { name: /^context1$/ })).toBeVisible()
  })

  test('Create Context button is visible on Contexts tab', async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.CREATE_CONTEXT_BUTTON)).toBeVisible()
  })

  test('clicking Create Context navigates to /contexts/new', async ({ authedPage }) => {
    await authedPage.click(CUI_DASHBOARD.CREATE_CONTEXT_BUTTON)
    await authedPage.waitForURL('**/contexts/new', { timeout: 10_000 })
    expect(authedPage.url()).toContain('/contexts/new')
  })

  test('clicking a context name navigates to context detail', async ({ authedPage }) => {
    await expect(authedPage.locator('table')).toBeVisible({ timeout: 15_000 })
    const firstLink = authedPage.locator('tbody tr:first-child td:first-child .cu-link')
    if ((await firstLink.count()) > 0) {
      await firstLink.first().click()
      await authedPage.waitForURL('**/contexts/**', { timeout: 10_000 })
      expect(authedPage.url()).toMatch(/\/contexts\/.+/)
    } else {
      test.skip() // No contexts in cluster yet
    }
  })
})
