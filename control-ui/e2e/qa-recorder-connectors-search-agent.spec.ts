// control-ui/e2e/qa-recorder-connectors-search-agent.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the Installed Connectors search box: typing an agent display
// name keeps the agent's connector row visible (access principals are part
// of the search haystack), a nonsense string lands the "No connectors match
// this search." empty state, and clearing the search restores the row. The
// private context slug backing the row never appears in the page body. The
// seeded server, host, and context are deleted via the Control API in a
// finally (server and host before the context).
//
// Contract: docs/testing/control-ui-headful-journeys.md.
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

test.describe('optional QA recorder: Control UI connectors search by agent', () => {
  test('optional QA recorder: Control UI connectors search by agent journey', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes an MCP server, host, and context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-connectors-search-agent'
    const serverName = uniqueE2EName('qa-csa-srv')
    const contextName = uniqueE2EName('qa-csa-ctx')
    const agentName = uniqueE2EName('qa-csa-agent')
    const noMatchQuery = uniqueE2EName('qa-csa-nomatch')

    try {
      await loginThroughUi(page, credentials)

      // Seed: one server carried by a private context bound to one agent —
      // the agent display name is an access principal on the connector row.
      const serverRes = await api(page.request, 'POST', '/api/v1/admin/mcp-servers', {
        metadata: { name: serverName },
        spec: {
          image: 'clerum/mock-mcp-server:test',
          contextRef: contextName,
          enabled: true,
          managed: true,
          transport: {
            type: 'streamableHttp',
            port: 3000,
            url: `http://${serverName}.mcp-server.svc.cluster.local:3000/mcp`,
          },
        },
      })
      expect(serverRes.status, `create mcp-server: ${JSON.stringify(serverRes.data)}`).toBeLessThan(
        300
      )

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder connectors search fixture',
          mcpServers: [serverName],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const hostRes = await api(page.request, 'POST', '/api/v1/admin/hosts', {
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: contextName,
          secretRef: '',
          channels: [],
        },
      })
      expect(hostRes.status, `create host: ${JSON.stringify(hostRes.data)}`).toBeLessThan(300)

      await page.goto(`${CONTROL_UI_URL}/connectors`)
      await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })
      await expect(
        page.getByText('Browse connector deployments and agent access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      const row = page.getByRole('button', { name: new RegExp(`Expand connector ${serverName}`) })
      await expect(row).toBeVisible({ timeout: 20_000 })

      // Typing the agent display name keeps the row: access principals are
      // part of the search haystack.
      const search = page.getByRole('searchbox', { name: 'Search connectors' })
      await search.fill(agentName)
      await expect(row).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-by-agent`)

      // A nonsense string matches nothing — the search empty state, not the
      // unfiltered table.
      await search.fill(noMatchQuery)
      await expect(row).toHaveCount(0)
      await expect(page.getByText('No connectors match this search.', { exact: true })).toBeVisible(
        {
          timeout: 20_000,
        }
      )
      await screenshotAndLog(page, testInfo, `${journey}-no-match`)

      // Clearing the search restores the row.
      await search.clear()
      await expect(row).toBeVisible({ timeout: 20_000 })

      // The private context slug is an implementation detail — never rendered.
      const bodyText = await page.innerText('body')
      expect(bodyText).not.toContain(contextName)
      await screenshotAndLog(page, testInfo, `${journey}-cleared`)
    } finally {
      // Best-effort cleanup; the disposable environment tolerates leftovers.
      // The server and host must go before the context.
      try {
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverName)}`
        )
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
        )
      } catch {
        // Ignore cleanup failures.
      }
    }
  })
})
