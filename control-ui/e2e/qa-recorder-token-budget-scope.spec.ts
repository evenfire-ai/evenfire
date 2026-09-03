// control-ui/e2e/qa-recorder-token-budget-scope.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires
// QA_RECORDER_CONFIRM_MUTATIONS=1. Ports the token-budget scope-label journey
// from tests/e2e/playwright/control-ui/token-budget-scope-label.spec.ts: a
// budget scoped on context_ref is created through the Control API, and the
// Token Budgets table must render its scope as "Connector scope" — the
// legacy "Context" wording must not appear in the budget's row. The budget
// and its staging context are deleted via the Control API in a finally.
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

test.describe('optional QA recorder: Control UI token budget connector scope label', () => {
  test('records a context_ref budget rendering as "Connector scope"', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a token budget and a staging context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-budget-ctx')
    const budgetName = uniqueE2EName('qa-recorder-budget-scope')
    let budgetId = ''

    try {
      await loginThroughUi(page, credentials)

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'qa recorder token budget scope fixture',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const budgetRes = await api<{ id?: string }>(page.request, 'POST', '/api/v1/admin/budgets', {
        name: budgetName,
        enabled: true,
        scope: { context_ref: [contextName] },
        unit: 'tokens',
        limit_amount: 1000000,
        period: 'monthly',
        timezone: 'UTC',
        enforcement: 'warn',
      })
      expect(budgetRes.status, `create budget: ${JSON.stringify(budgetRes.data)}`).toBeLessThan(300)
      budgetId = String(budgetRes.data.id || '')

      // Cost & Usage is an expandable sidebar group rendered as a <button>
      // (its children only enter the DOM when expanded). After login we land
      // on /agents, so expand it — guarded on aria-expanded to stay resilient
      // if the group is already open — then take the Token Budgets child
      // link like an operator would.
      const costToggle = page.getByRole('button', { name: 'Cost & Usage', exact: true })
      await expect(costToggle).toBeVisible({ timeout: 20_000 })
      if ((await costToggle.getAttribute('aria-expanded')) !== 'true') {
        await costToggle.click()
      }
      const tokenBudgetsLink = page.getByRole('link', { name: 'Token Budgets', exact: true })
      await expect(tokenBudgetsLink).toBeVisible({ timeout: 20_000 })
      await tokenBudgetsLink.click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets/, { timeout: 20_000 })
      await expect(
        page.getByText('Spend caps per dimension, shown against live usage.')
      ).toBeVisible({ timeout: 20_000 })

      const row = page.locator('tr', { hasText: budgetName }).first()
      await expect(row).toBeVisible({ timeout: 20_000 })

      await expect(row.getByText('Connector scope', { exact: true })).toBeVisible()
      const rowText = await row.innerText()
      expect(rowText, 'budget row must not use the legacy "Context" wording').not.toMatch(
        /\bContext\b/
      )
      await screenshotAndLog(page, testInfo, 'control-ui-token-budget-scope')
    } finally {
      if (budgetId) {
        await api(page.request, 'DELETE', `/api/v1/admin/budgets/${encodeURIComponent(budgetId)}`)
      }
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
