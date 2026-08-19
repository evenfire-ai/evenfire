// control-ui/e2e/qa-recorder-llm-price.spec.ts
//
// Optional headful QA recorder journey for the Control UI "Cost & Usage" ->
// LLM prices add/edit/delete flow. MUTATING: it creates an LLM price, edits
// its output price, deletes it from the list, then best-effort deletes the
// price through the Control API in finally. Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
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

type PriceRow = { id: string; model: string }

async function findPriceId(request: APIRequestContext, model: string): Promise<string | undefined> {
  const { status, data } = await api<{ rows?: PriceRow[] }>(
    request,
    'GET',
    '/api/v1/admin/llm-prices'
  )
  if (status !== 200) return undefined
  return (data.rows ?? []).find(row => row.model === model)?.id
}

async function waitForPriceId(request: APIRequestContext, model: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await findPriceId(request, model)
    if (id) return id
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created LLM price for "${model}" did not appear through Control API.`)
}

test.describe('optional QA recorder: Control UI LLM price', () => {
  test('LLM price — add → edit → delete', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates, edits, and deletes an LLM price.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const model = uniqueE2EName('qa-recorder-model')
    let priceId = ''

    try {
      await loginThroughUi(page, credentials)

      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/llm-prices/new`)
      await expect(page.getByRole('heading', { name: 'Add LLM price', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      // Provider is left at its default (any provider); only the model name and
      // per-1M-token prices are filled.
      await page.locator('#llm-price-model').fill(model)
      await page.locator('#llm-price-input_token_price').fill('1')
      await page.locator('#llm-price-output_token_price').fill('2')
      await page.locator('#llm-price-cache_read_token_price').fill('0.5')
      await page.locator('#llm-price-cache_write_token_price').fill('1.5')
      await page.locator('#llm-price-currency').fill('USD')
      await page.locator('.cu-px-form').getByLabel('Enabled').check()

      await page.getByRole('button', { name: 'Add price', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/llm-prices$/, { timeout: 20_000 })

      priceId = await waitForPriceId(page.request, model)
      expect(priceId).toBeTruthy()

      await page.goto(
        `${CONTROL_UI_URL}/cost-and-usage/llm-prices/${encodeURIComponent(priceId)}/edit`
      )
      await expect(page.locator('#llm-price-model')).toHaveValue(model, { timeout: 20_000 })
      await page.locator('#llm-price-output_token_price').fill('3')
      await page.getByRole('button', { name: 'Save price', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/llm-prices$/, { timeout: 20_000 })

      // Delete from the list: scope to this price's row so the edit/delete icon
      // buttons are unambiguous, then drive the danger confirm dialog.
      const row = page.locator('table.cu-table tr', { hasText: model }).first()
      await row.getByRole('button', { name: /Delete price/ }).click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Delete price' })
      await expect(confirmDialog).toBeVisible({ timeout: 20_000 })
      await confirmDialog.getByRole('button', { name: 'Delete', exact: true }).click()
      await expect(page.locator('table.cu-table tr', { hasText: model })).toHaveCount(0, {
        timeout: 20_000,
      })

      await screenshotAndLog(page, testInfo, 'control-ui-llm-price')
    } finally {
      const id = priceId || (await findPriceId(page.request, model))
      if (id) {
        await api(page.request, 'DELETE', `/api/v1/admin/llm-prices/${encodeURIComponent(id)}`)
      }
    }
  })
})
