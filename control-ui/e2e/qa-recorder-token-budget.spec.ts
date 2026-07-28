// control-ui/e2e/qa-recorder-token-budget.spec.ts
//
// Optional headful QA recorder journey for the Control UI "Cost & Usage" ->
// token budgets create/edit flow. MUTATING: it creates a global cost budget,
// edits its limit + enforcement, then deletes the budget through the Control
// API in finally. Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
import { type APIRequestContext, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

type BudgetRow = { id: string; name: string }

async function findBudgetId(request: APIRequestContext, name: string): Promise<string | undefined> {
  const { status, data } = await api<{ rows?: BudgetRow[] }>(
    request,
    'GET',
    '/api/v1/admin/budgets'
  )
  if (status !== 200) return undefined
  return (data.rows ?? []).find(row => row.name === name)?.id
}

async function waitForBudgetId(request: APIRequestContext, name: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await findBudgetId(request, name)
    if (id) return id
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created budget "${name}" did not appear through Control API.`)
}

test.describe('optional QA recorder: Control UI token budget', () => {
  test('Token budget — global scope, create + edit', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates, edits, and deletes a token budget.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const name = uniqueE2EName('qa-recorder-budget')
    let budgetId = ''

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/token-budgets/new`)
      await expect(
        page.getByRole('heading', { name: 'New token budget', exact: true })
      ).toBeVisible({
        timeout: 20_000,
      })

      await page.locator('#budget-name').fill(name)
      await page.locator('#budget-unit').selectOption('cost')
      await page.locator('#budget-limit').fill('100')
      await page.locator('#budget-currency').fill('USD')
      await page.locator('#budget-period').selectOption('monthly')
      await page.locator('#budget-enforcement').selectOption('warn')
      await page.locator('.cu-tb-form').getByLabel('Enabled').check()

      // Scope left empty (global). The FormSection helper text always renders,
      // so it is the resilient proof that a global scope is accepted.
      await expect(
        page.getByText('Dimensions are ANDed; values within one are ORed.')
      ).toBeVisible()

      await page.getByRole('button', { name: 'Create budget', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets$/, { timeout: 20_000 })

      budgetId = await waitForBudgetId(page.request, name)
      expect(budgetId).toBeTruthy()

      await page.goto(
        `${CONTROL_UI_URL}/cost-and-usage/token-budgets/${encodeURIComponent(budgetId)}/edit`
      )
      await expect(page.locator('#budget-name')).toHaveValue(name, { timeout: 20_000 })
      await page.locator('#budget-limit').fill('250')
      await page.locator('#budget-enforcement').selectOption('block')
      await page.getByRole('button', { name: 'Save budget', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets$/, { timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-token-budget')
    } finally {
      const id = budgetId || (await findBudgetId(page.request, name))
      if (id) {
        await api(page.request, 'DELETE', `/api/v1/admin/budgets/${encodeURIComponent(id)}`)
      }
    }
  })
})
