/**
 * Control UI — Agent detail overview Connectors summary
 *
 * /agents/<name> opens the agent's Overview tab by default. The overview must
 * summarize the agent's attached connectors (the count badge and the chip
 * block derive from the private context's mcpServers enrichment) while the
 * private context slug itself stays an implementation detail — it must never
 * appear anywhere on the page.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Agent overview Connectors summary', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('overview shows the connectors count and chips without the context slug', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const agentName = `e2e-aoc-agent-${stamp}`
    const contextName = `e2e-aoc-ctx-${stamp}`
    const serverOne = `e2e-aoc-srv-a-${stamp}`
    const serverTwo = `e2e-aoc-srv-b-${stamp}`
    try {
      // PRECONDITION (labeled setup): a private context carrying two MCP
      // servers, plus a host bound to it — the overview summary derives from
      // this context enrichment, not from the Host CR itself.
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
          description: `Overview fixture for ${agentName}`,
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

      // /agents/<name> without a tab segment opens the Overview by default.
      await authedPage.goto(`/agents/${encodeURIComponent(agentName)}`)
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByRole('region', { name: 'Lifecycle' })).toBeVisible()

      // Connectors summary card: nav header with the count badge…
      const connectorsCard = authedPage.getByRole('region', { name: 'Connectors', exact: true })
      await expect(connectorsCard).toBeVisible({ timeout: 15_000 })
      await expect(connectorsCard.locator('.cu-host-overview-nav-header__count')).toHaveText('2', {
        timeout: 20_000,
      })

      // …and the chip block with both connector names.
      const chips = connectorsCard.locator('.cu-host-overview-mcp__chip')
      await expect(chips).toHaveCount(2, { timeout: 20_000 })
      await expect(chips.filter({ hasText: serverOne })).toBeVisible()
      await expect(chips.filter({ hasText: serverTwo })).toBeVisible()

      // The private context slug never renders anywhere on the page.
      await expect(authedPage.getByText(contextName)).toHaveCount(0)
      const bodyText = await authedPage.locator('body').innerText()
      expect(bodyText).not.toContain(contextName)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
      await controlApi.ensureMcpServerDeleted(serverOne)
      await controlApi.ensureMcpServerDeleted(serverTwo)
      await controlApi.ensureContextDeleted(contextName)
    }
  })
})
