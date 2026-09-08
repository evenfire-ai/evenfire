/**
 * Control UI — Token budget scope label tests
 *
 * A budget scoped on context_ref must render the scope chip as
 * "Connector scope: <id>" (formatBudgetScope joins the dimension label and
 * value). The legacy "Context" wording must not appear in the scope cell.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN_ID = Date.now()
const CONTEXT_NAME = `e2e-pw-budget-ctx-${RUN_ID}`
const BUDGET_NAME = `e2e-pw-budget-${RUN_ID}`

test.describe('Control UI — Token budgets — scope label', () => {
  let budgetId = ''

  test.beforeAll(async () => {
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_NAME, description: 'token-budget scope label fixture' },
    })
  })

  test.afterAll(async () => {
    if (budgetId) await controlApi.ensureBudgetDeleted(budgetId)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('context_ref budget scope renders as "Connector scope"', async ({ authedPage }) => {
    const budget = await controlApi.createBudget({
      name: BUDGET_NAME,
      enabled: true,
      scope: { context_ref: [CONTEXT_NAME] },
      unit: 'tokens',
      limit_amount: 1000000,
      period: 'monthly',
      timezone: 'UTC',
      enforcement: 'warn',
    })
    budgetId = budget.id

    await authedPage.goto('/cost-and-usage/token-budgets')
    const row = authedPage.locator('tr', { hasText: BUDGET_NAME }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Column order: Name, Scope, Unit, … (TokenBudgetTable BUDGET_COLUMNS).
    const scopeCell = row.locator('td').nth(1)
    await expect(scopeCell.getByText('Connector scope', { exact: true })).toBeVisible()
    await expect(scopeCell.getByText(CONTEXT_NAME, { exact: true })).toBeVisible()

    const scopeText = await scopeCell.innerText()
    expect(scopeText, 'scope cell must not use the legacy "Context" wording').not.toMatch(
      /\bContext\b/
    )
  })
})
