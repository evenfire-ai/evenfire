/**
 * Control UI — Agents list connectors hover card
 *
 * The /agents table summarizes each agent's attached connectors in a count
 * cell. The agent's private context slug is an implementation detail: the
 * hover card must show a neutral "Connectors" heading plus the MCP-server
 * names, never the context. Clicking the count opens the agent's connectors
 * tab.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Agents list connectors hover card', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('connectors cell hover shows server names without the context slug, click opens the connectors tab', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const agentName = `e2e-ach-agent-${stamp}`
    const contextName = `e2e-ach-ctx-${stamp}`
    const serverOne = `e2e-ach-srv-a-${stamp}`
    const serverTwo = `e2e-ach-srv-b-${stamp}`
    try {
      // PRECONDITION (labeled setup): a private context carrying two MCP
      // servers, plus a host bound to it — the count cell derives from this
      // context enrichment, not from the Host CR itself.
      for (const serverName of [serverOne, serverTwo]) {
        await controlApi.createMcpServer({
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
      }
      await controlApi.createContext({
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: `Hover-card fixture for ${agentName}`,
          mcpServers: [serverOne, serverTwo],
        },
      })
      await controlApi.createHost({
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef: contextName,
          secretRef: '',
          channels: [],
        },
      })

      await authedPage.goto('/agents')
      await expect(
        authedPage.getByRole('columnheader', { name: 'Connectors', exact: true })
      ).toBeVisible({ timeout: 15_000 })

      const row = authedPage.getByRole('row', { name: new RegExp(agentName) })
      await expect(row).toBeVisible({ timeout: 20_000 })

      // The count reflects the context enrichment once the contexts fetch
      // resolves — wait for the concrete value, not just the button.
      const countButton = row.locator('.cu-host-connectors-count')
      await expect(countButton).toHaveText('2', { timeout: 20_000 })

      // Hover (focus mirrors hover) reveals the tooltip with the connector
      // names — and never the private context slug.
      await countButton.hover()
      const tooltip = authedPage.getByRole('tooltip')
      await expect(tooltip).toBeVisible({ timeout: 10_000 })
      await expect(tooltip).toContainText('Connectors')
      await expect(tooltip).toContainText(serverOne)
      await expect(tooltip).toContainText(serverTwo)

      const rowText = await row.innerText()
      const tooltipText = await tooltip.innerText()
      expect(rowText).not.toContain(contextName)
      expect(tooltipText).not.toContain(contextName)

      // Clicking the count opens the agent's connectors tab.
      await countButton.click()
      await authedPage.waitForURL(`**/agents/${agentName}/connectors`, { timeout: 15_000 })
    } finally {
      await controlApi.ensureHostDeleted(agentName)
      await controlApi.ensureMcpServerDeleted(serverOne)
      await controlApi.ensureMcpServerDeleted(serverTwo)
      await controlApi.ensureContextDeleted(contextName)
    }
  })
})
