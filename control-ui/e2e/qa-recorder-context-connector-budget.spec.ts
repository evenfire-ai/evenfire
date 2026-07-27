// control-ui/e2e/qa-recorder-context-connector-budget.spec.ts
//
// Mutating QA recorder combo: context + discovery connector (bound to the
// context) + global token budget + verify both land. Creates and tears down
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

type BudgetRow = { id?: string; name?: string }

async function waitForBudgetId(
  request: import('@playwright/test').APIRequestContext,
  name: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status, data } = await api<{ rows?: BudgetRow[] }>(
      request,
      'GET',
      '/api/v1/admin/budgets'
    )
    if (status === 200) {
      const found = (data.rows ?? []).find(row => row.name === name)
      if (found?.id) return found.id
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created budget "${name}" did not become visible through Control API.`)
}

test.describe('optional QA recorder: Control UI context connector budget combo', () => {
  test('records the context + connector + global budget combo', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a context, a connector, and a token budget.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-ctx')
    const connectorName = uniqueE2EName('qa-recorder-connector')
    const budgetName = uniqueE2EName('qa-recorder-global-budget')
    let budgetId = ''

    try {
      await loginThroughUi(page, credentials)

      // step 1: create a context (name only).
      await page.goto(`${CONTROL_UI_URL}/contexts/new`)
      await expect(page).toHaveURL(/\/contexts\/new$/, { timeout: 20_000 })
      await page.getByLabel('Context name').fill(contextName)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Create context', exact: true }).click()
      await expect(page).toHaveURL(new RegExp(`/contexts/${contextName}$`), { timeout: 20_000 })

      // step 2: register a discovery connector bound to the context (stdio,
      // not managed, no secret).
      await page.goto(`${CONTROL_UI_URL}/connectors/new`)
      await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })
      await expect(
        page.getByRole('heading', { name: 'Create connector', exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await page.getByPlaceholder('my-mcp-server', { exact: true }).fill(connectorName)
      await page
        .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest', {
          exact: true,
        })
        .fill('qa-recorder/example:dev')
      const contextDropdown = page.locator('.cu-selection-dropdown__button')
      await expect(contextDropdown).toBeVisible({ timeout: 10_000 })
      await contextDropdown.click()
      await page.getByPlaceholder('Search contexts...').fill(contextName)
      const contextOption = page.getByRole('option', { name: contextName, exact: true })
      await expect(contextOption).toBeVisible({ timeout: 10_000 })
      await contextOption.click()
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      // Runtime: stdio transport + discovery only (Managed = No).
      await page
        .locator('.cu-field')
        .filter({ hasText: 'Transport Type' })
        .locator('select')
        .selectOption('stdio')
      await page
        .locator('.cu-field')
        .filter({ hasText: /^Managed$/ })
        .locator('select')
        .selectOption('false')
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      // Network egress: leave empty, continue.
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      // Secrets: leave unchecked, create the connector.
      await page.getByRole('button', { name: 'Create connector', exact: true }).click()
      await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })

      // step 3: verify the connector appears on the context detail Connectors tab.
      await page.goto(`${CONTROL_UI_URL}/contexts/${encodeURIComponent(contextName)}/connectors`)
      await expect(page).toHaveURL(/\/contexts\/.+\/connectors$/, { timeout: 20_000 })
      await expect(
        page.getByText('Review details, manage connectors, agents, teams, and members.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(connectorName, { exact: true })).toBeVisible({ timeout: 15_000 })

      // step 4: create a global token budget (no scope).
      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/token-budgets/new`)
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets\/new$/, { timeout: 20_000 })
      await page.locator('#budget-name').fill(budgetName)
      await page.locator('#budget-limit').fill('10')
      await page.getByRole('button', { name: 'Create budget', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets$/, { timeout: 20_000 })
      budgetId = await waitForBudgetId(page.request, budgetName)

      // step 5: verify the budget lists on the token budgets page.
      await expect(
        page.getByText(
          'Spend caps per dimension, shown against live usage. P0c runs in observation mode (warn).',
          { exact: true }
        )
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(budgetName, { exact: true })).toBeVisible({ timeout: 15_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-context-connector-budget')
    } finally {
      const request = page.request
      // Reverse-order cleanup: budget → connector → context (best-effort each).
      if (budgetId) {
        try {
          await api(request, 'DELETE', `/api/v1/admin/budgets/${encodeURIComponent(budgetId)}`)
        } catch {
          // best-effort
        }
      }
      try {
        await api(
          request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
        )
      } catch {
        // best-effort
      }
      try {
        await api(request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
      } catch {
        // best-effort
      }
    }
  })
})
