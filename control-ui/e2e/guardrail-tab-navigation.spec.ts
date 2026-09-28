import { expect, test } from '@playwright/test'

if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
  test.use({ launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } })
}

const hook = {
  metadata: { name: 'sample-hook' },
  spec: { path: '/check', lifecyclePoints: ['preCall'], failMode: 'open' },
  status: { conditions: [{ type: 'Ready', status: 'True' }] },
}

test.beforeEach(async ({ page }) => {
  await page.route('**/control-api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const body = path.endsWith('/api/v1/admin/auth/me')
      ? { me: { id: 'admin-1', username: 'admin', email: 'admin@example.com' } }
      : path.endsWith('/api/v1/admin/llm-hooks/sample-hook')
        ? hook
        : path.endsWith('/api/v1/admin/hosts')
          ? {
              items: [
                {
                  metadata: { name: 'sample-agent' },
                  spec: { guardrails: { hooks: { preCall: [{ id: 'sample-hook' }] } } },
                },
              ],
            }
          : path.endsWith('/api/v1/admin/control-admin-bridge/status')
            ? {
                admin: { id: 'admin-1', email: 'admin@example.com', username: 'admin' },
                member: { id: 'member-1', email: 'admin@example.com' },
              }
            : {}
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
  })
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
