import { expect, test } from '@playwright/test'

test('connector detail tabs navigate once and browser back restores configuration', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('controlUiAdminToken', 'connector-detail-tab-test-token')
  })

  await page.route('**/api/v1/admin/**', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.endsWith('/api/v1/admin/auth/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ me: { id: 'test-admin', username: 'test-admin', role: 'admin' } }),
      })
      return
    }

    if (pathname.endsWith('/api/v1/admin/mcp-servers/search')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          metadata: { name: 'search', namespace: 'mcp-server' },
          spec: { description: 'Search the public web' },
          status: {
            conditions: [{ type: 'Ready', status: 'True', message: 'Connector is ready.' }],
          },
        }),
      })
      return
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/connectors/search')
  await expect(page.getByRole('heading', { name: 'Connector: search' })).toBeVisible()
  await expect(page.getByText('Search the public web')).toBeVisible()

  await page.getByRole('tab', { name: 'Runtime status' }).click()
  await expect(page).toHaveURL(/\/connectors\/search\/runtime$/)
  await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible()
  await expect(page.getByText('Connector is ready.')).toBeVisible()

  await page.goBack()
  await expect(page).toHaveURL(/\/connectors\/search\/?$/)
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible()
  await expect(page.getByText('Search the public web')).toBeVisible()
})
