// control-ui/e2e/qa-recorder-token-budget-team.spec.ts
//
// Optional headful QA recorder journey for a team-scoped token budget. MUTATING:
// it creates a temporary team, creates a cost budget scoped to that team via the
// ScopeSelector, then deletes both the budget and the team through the Control
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

type IdName = { id: string; name: string }

async function findTeamId(request: APIRequestContext, name: string): Promise<string | undefined> {
  const { status, data } = await api<{ items?: IdName[] }>(request, 'GET', '/api/v1/admin/teams')
  if (status !== 200) return undefined
  return (data.items ?? []).find(item => item.name === name)?.id
}

async function waitForTeamId(request: APIRequestContext, name: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = await findTeamId(request, name)
    if (id) return id
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created team "${name}" did not appear through Control API.`)
}

async function findBudgetId(request: APIRequestContext, name: string): Promise<string | undefined> {
  const { status, data } = await api<{ rows?: IdName[] }>(request, 'GET', '/api/v1/admin/budgets')
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

test.describe('optional QA recorder: Control UI token budget team scope', () => {
  test('Token budget scoped to a team (creates its own team)', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a team and a team-scoped token budget.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const teamName = uniqueE2EName('qa-recorder-team')
    const budgetName = uniqueE2EName('qa-recorder-budget-team')
    let teamId = ''
    let budgetId = ''

    try {
      await loginThroughUi(page, credentials)

      // Minimal team shell: name, then skip members/contexts/agents.
      await page.goto(`${CONTROL_UI_URL}/users-and-teams/teams/new`)
      await expect(page.getByRole('heading', { name: 'Create team', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await page.locator('#new-team-name').fill(teamName)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
      teamId = await waitForTeamId(page.request, teamName)
      expect(teamId).toBeTruthy()

      await page.goto(`${CONTROL_UI_URL}/cost-and-usage/token-budgets/new`)
      await expect(
        page.getByRole('heading', { name: 'New token budget', exact: true })
      ).toBeVisible({
        timeout: 20_000,
      })
      await page.locator('#budget-name').fill(budgetName)
      await page.locator('#budget-unit').selectOption('cost')
      await page.locator('#budget-limit').fill('50')
      await page.locator('#budget-period').selectOption('monthly')
      await page.locator('#budget-enforcement').selectOption('warn')
      await page.locator('.cu-tb-form').getByLabel('Enabled').check()

      // Scope: add the Team dimension and select the team just created. The
      // ScopeSelector loads team options async, so wait for this team's option
      // to attach before selecting it by value (the team id).
      const teamScopeSelect = page.getByLabel('Add Team to scope')
      await expect(teamScopeSelect.locator('option', { hasText: teamName })).toBeAttached({
        timeout: 20_000,
      })
      await teamScopeSelect.selectOption(teamId)
      await expect(
        page.locator('.cu-tb-scope-editor .cu-tb-chip__label', { hasText: teamName })
      ).toBeVisible()

      await page.getByRole('button', { name: 'Create budget', exact: true }).click()
      await expect(page).toHaveURL(/\/cost-and-usage\/token-budgets$/, { timeout: 20_000 })
      budgetId = await waitForBudgetId(page.request, budgetName)
      expect(budgetId).toBeTruthy()

      await screenshotAndLog(page, testInfo, 'control-ui-token-budget-team')
    } finally {
      const bId = budgetId || (await findBudgetId(page.request, budgetName))
      if (bId) {
        await api(page.request, 'DELETE', `/api/v1/admin/budgets/${encodeURIComponent(bId)}`)
      }
      const tId = teamId || (await findTeamId(page.request, teamName))
      if (tId) {
        await api(page.request, 'DELETE', `/api/v1/admin/teams/${encodeURIComponent(tId)}`)
      }
    }
  })
})
