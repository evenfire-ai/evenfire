import { expect, test } from '@playwright/test'

test('connector detail access tabs manage agents and refresh derived users and teams', async ({
  page,
}) => {
  let connectorDetailRequests = 0
  let contextReads = 0
  let contexts = [
    {
      metadata: { name: 'alpha-context', resourceVersion: '1' },
      spec: { contextId: 'alpha-context', mcpServers: ['search'], sharedFileSystems: [] },
    },
    {
      metadata: { name: 'beta-context', resourceVersion: '3' },
      spec: { contextId: 'beta-context', mcpServers: [], sharedFileSystems: [] },
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem('controlUiAdminToken', 'connector-detail-access-test-token')
  })

  await page.route('**/api/v1/admin/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname

    if (pathname.endsWith('/api/v1/admin/auth/me')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ me: { id: 'test-admin', username: 'test-admin', role: 'admin' } }),
      })
      return
    }

    if (pathname.endsWith('/api/v1/admin/mcp-servers/search')) {
      connectorDetailRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          metadata: { name: 'search', namespace: 'mcp-server' },
          spec: { description: 'Search the public web' },
          status: { conditions: [] },
        }),
      })
      return
    }

    if (pathname.endsWith('/api/v1/admin/contexts') && request.method() === 'GET') {
      contextReads += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: contexts }),
      })
      return
    }

    if (pathname.endsWith('/api/v1/admin/hosts')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              metadata: { name: 'agent-alpha' },
              spec: { host: 'Alpha Agent', contextRef: 'alpha-context' },
            },
            {
              metadata: { name: 'agent-beta' },
              spec: { host: 'Beta Agent', contextRef: 'beta-context' },
            },
          ],
        }),
      })
      return
    }

    if (pathname.endsWith('/api/v1/admin/contexts/beta-context') && request.method() === 'PUT') {
      const payload = request.postDataJSON()
      contexts = contexts.map(context =>
        context.metadata.name === 'beta-context'
          ? {
              ...context,
              metadata: { ...context.metadata, resourceVersion: '4' },
              spec: { ...context.spec, ...payload.spec },
            }
          : context
      )
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(contexts[1]),
      })
      return
    }

    const userMatch = pathname.match(/\/api\/v1\/admin\/agents\/(agent-(?:alpha|beta))\/users$/)
    if (userMatch) {
      const items =
        userMatch[1] === 'agent-alpha'
          ? [{ id: 'user-ada', displayName: 'Ada' }]
          : [{ id: 'user-grace', displayName: 'Grace' }]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items }),
      })
      return
    }

    const teamMatch = pathname.match(/\/api\/v1\/admin\/agents\/(agent-(?:alpha|beta))\/teams$/)
    if (teamMatch) {
      const items =
        teamMatch[1] === 'agent-alpha'
          ? [{ id: 'team-growth', name: 'Growth' }]
          : [{ id: 'team-research', name: 'Research' }]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items }),
      })
      return
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' })
  })

  await page.goto('/connectors/search/agents')
  await expect(page.getByRole('heading', { name: 'Connector: search' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Alpha Agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add agent' })).toBeVisible()
  expect(connectorDetailRequests).toBe(1)

  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog', { name: 'Give agents access to this connector' })
  await dialog.getByRole('checkbox', { name: /Beta Agent/ }).check()
  await dialog.getByRole('button', { name: 'Add to agent' }).click()
  await expect(page.getByRole('link', { name: 'Beta Agent' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText(/Users and Teams summaries now reflect/)

  await page.getByRole('tab', { name: 'Users' }).click()
  await expect(page).toHaveURL(/\/connectors\/search\/users$/)
  await expect(page.getByRole('link', { name: 'Ada' })).toHaveAttribute(
    'href',
    '/users-and-teams/users/user-ada/agents'
  )
  await expect(page.getByRole('link', { name: 'Grace' })).toBeVisible()
  await expect(page.getByText(/derived from the agents each user can access/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /actions for connector access/i })).toHaveCount(0)

  await page.getByRole('tab', { name: 'Teams' }).click()
  await expect(page).toHaveURL(/\/connectors\/search\/teams$/)
  await expect(page.getByRole('link', { name: 'Growth' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Research' })).toBeVisible()
  await expect(page.getByText(/derived from the agents assigned to each team/i)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add agent' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /actions for connector access/i })).toHaveCount(0)

  expect(connectorDetailRequests).toBe(1)
  expect(contextReads).toBe(2)
})
