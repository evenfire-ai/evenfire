// control-ui/e2e/qa-recorder-cost-governance.spec.ts
//
// Mutating QA recorder combo: cost governance (LLM model + LLM price + a token
// budget scoped to that model + verify usage view). Creates and tears down
// every resource. Requires QA_RECORDER_CONFIRM_MUTATIONS=1 in .env.qa-recorder.
import { expect, test } from '@playwright/test'
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

type RowItem = { id?: string; model?: string; name?: string }

async function waitForRow(
  request: import('@playwright/test').APIRequestContext,
  pathName: string,
  matchField: string,
  matchValue: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status, data } = await api<{ rows?: RowItem[] }>(request, 'GET', pathName)
    if (status === 200) {
      const found = (data.rows ?? []).find(
        row => String((row as Record<string, unknown>)[matchField] ?? '') === matchValue
      )
      if (found?.id) return found.id
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created resource "${matchValue}" did not become visible through Control API.`)
}

test.describe('optional QA recorder: Control UI cost governance combo', () => {
  test('records the cost governance combo (model, price, model-scoped budget)', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes an LLM model, an LLM price, and a token budget.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const modelName = uniqueE2EName('qa-recorder-model')
    const budgetName = uniqueE2EName('qa-recorder-budget')
    let modelId = ''
    let priceId = ''
    let budgetId = ''

    try {
      await loginThroughUi(page, credentials)

      // step 1: add an allowed LLM model (provider defaults to the first option).
      await page.goto(`${CONTROL_UI_URL}/llm-models/new`)
      await expect(page).toHaveURL(/\/llm-models\/new$/, { timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: 'Add allowed model', exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await page.locator('#llm-model-name').fill(modelName)
      await page.getByRole('button', { name: 'Add model', exact: true }).click()
      await expect(page).toHaveURL(/\/llm-models$/, { timeout: 20_000 })
      modelId = await waitForRow(page.request, '/api/v1/admin/llm-models', 'model', modelName)

      // step 2: add an active LLM price for that model (same default provider).
      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/llm-prices/new`)
      await expect(page).toHaveURL(/\/cost-and-usage\/llm-prices\/new$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Add LLM price', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await page.locator('#llm-price-model').fill(modelName)
      await page.locator('#llm-price-input_token_price').fill('1')
      await page.getByRole('button', { name: 'Add price', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/llm-prices$/, { timeout: 20_000 })
      priceId = await waitForRow(page.request, '/api/v1/admin/llm-prices', 'model', modelName)

      // step 3: create a cost budget scoped to that model via the ScopeSelector
      // Model dimension (free-text + Add).
      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/token-budgets/new`)
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets\/new$/, { timeout: 20_000 })
      await page.locator('#budget-name').fill(budgetName)
      await page.locator('#budget-limit').fill('10')
      await page.getByLabel('Add Model to scope').fill(modelName)
      await page.getByRole('button', { name: 'Add', exact: true }).click()
      await expect(page.locator('.cu-tb-chip').filter({ hasText: modelName })).toBeVisible({
        timeout: 10_000,
      })
      await page.getByRole('button', { name: 'Create budget', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets$/, { timeout: 20_000 })
      budgetId = await waitForRow(page.request, '/api/v1/admin/budgets', 'name', budgetName)

      // step 4: verify the usage dashboard shell renders with the model in place.
      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/usage`)
      await expect(page).toHaveURL(/\/cost-and-usage\/usage/, { timeout: 20_000 })
      await expect(page.locator('.cu-panel-title').filter({ hasText: 'LLM Usage' })).toBeVisible({
        timeout: 20_000,
      })

      await screenshotAndLog(page, testInfo, 'control-ui-cost-governance')
    } finally {
      const request = page.request
      // Reverse-order cleanup: budget → price → model (best-effort each).
      if (budgetId) {
        try {
          await api(request, 'DELETE', `/api/v1/admin/budgets/${encodeURIComponent(budgetId)}`)
        } catch {
          // best-effort
        }
      }
      if (priceId) {
        try {
          await api(request, 'DELETE', `/api/v1/admin/llm-prices/${encodeURIComponent(priceId)}`)
        } catch {
          // best-effort
        }
      }
      if (modelId) {
        try {
          await api(request, 'DELETE', `/api/v1/admin/llm-models/${encodeURIComponent(modelId)}`)
        } catch {
          // best-effort
        }
      }
    }
  })
})
