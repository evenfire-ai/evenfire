import { expect, test } from '@playwright/test'
import { buildGuardrailDetailScenario } from '../test/fixtures/guardrailProducer'

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } })
}

const scenario = buildGuardrailDetailScenario()
let unexpectedApiPaths: string[] = []

test.beforeEach(async ({ page }) => {
  unexpectedApiPaths = []
  await page.route('**/control-api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let body: unknown
    if (path === '/control-api/api/v1/admin/auth/me') {
      body = { me: { id: 'admin-1', username: 'admin', email: 'admin@example.com' } }
    } else if (path === '/control-api/api/v1/admin/llm-hooks/sample-hook') {
      body = scenario.hook
    } else if (path === '/control-api/api/v1/admin/hosts') {
      body = scenario.hosts
    } else if (path === '/control-api/api/v1/admin/settings/bridge-status') {
      body = {
        admin: {
          id: 'admin-1',
          username: 'admin',
          email: 'admin@example.com',
          emailConfirmed: true,
          pendingEmailChange: null,
        },
        member: { id: 'member-1', email: 'admin@example.com' },
      }
    } else if (path === '/control-api/api/v1/admin/registry/publish-scope') {
      body = { scope: null, curator: false, orgName: null }
    } else {
      unexpectedApiPaths.push(path)
      await route.fulfill({ status: 500, body: `Unexpected API request: ${path}` })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
})

test.afterEach(() => {
  expect(unexpectedApiPaths).toEqual([])
})

test('guardrail tab links support deep links and browser Back', async ({ page }) => {
  await page.goto('/guardrails/sample-hook/agents')
  await expect(page.getByRole('tab', { name: 'Agents with access' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  await expect(page.getByText('sample-agent')).toBeVisible()
  await expect(page).toHaveURL(/\/guardrails\/sample-hook\/agents$/)

  await page.goto('/guardrails/sample-hook/details')
  await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByText('Runtime configuration reported by the installed hook.')
  ).toBeVisible()

  const agentsTab = page.getByRole('tab', { name: 'Agents with access' })
  await expect(agentsTab).toHaveAttribute('href', '/guardrails/sample-hook/agents')
  await agentsTab.click()
  await expect(page).toHaveURL(/\/guardrails\/sample-hook\/agents$/)
  await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('sample-agent')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/guardrails\/sample-hook\/details$/)
  await expect(page.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByText('Runtime configuration reported by the installed hook.')
  ).toBeVisible()
})
