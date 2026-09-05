/**
 * Control UI — Connector edit Access tab
 *
 * /connectors/<name>/edit exposes Credentials / External Egress / Access.
 * The Access tab is a read-only view of the agents, teams, and users that
 * can reach the connector; the legacy /edit/context deep link redirects to
 * it.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Connector edit Access tab', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('Access tab shows read-only agent access and the legacy context tab redirects to it', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000)
    const stamp = Date.now()
    const serverName = `e2e-ceat-srv-${stamp}`
    const contextName = `e2e-ceat-ctx-${stamp}`
    const agentName = `e2e-ceat-agent-${stamp}`
    try {
      // PRECONDITION (labeled setup): a connector bound to the agent's
      // context via spec.mcpServers, so the edit page's Access tab resolves
      // a non-empty Agents group.
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
      await controlApi.createContext({
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: `Connector edit fixture for ${agentName}`,
          mcpServers: [serverName],
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

      // The edit page exposes exactly the three sections as tabs.
      await authedPage.goto(`/connectors/${encodeURIComponent(serverName)}/edit`)
      await expect(
        authedPage.getByRole('heading', { name: `Edit Connector: ${serverName}`, exact: true })
      ).toBeVisible({ timeout: 15_000 })
      const tablist = authedPage.getByRole('tablist', { name: 'Connector edit sections' })
      await expect(tablist).toBeVisible()
      await expect(tablist.getByRole('tab', { name: 'Credentials', exact: true })).toBeVisible()
      await expect(tablist.getByRole('tab', { name: 'External Egress', exact: true })).toBeVisible()
      await expect(tablist.getByRole('tab', { name: 'Access', exact: true })).toBeVisible()

      // Open the Access tab — read-only groups headed by the bound agent.
      await tablist.getByRole('tab', { name: 'Access', exact: true }).click()
      await authedPage.waitForURL(`**/connectors/${serverName}/edit/access`, {
        timeout: 15_000,
      })
      await expect(
        authedPage.getByRole('heading', { name: 'Agent access', exact: true })
      ).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
      await expect(authedPage.getByText(agentName, { exact: true })).toBeVisible({
        timeout: 15_000,
      })

      // Legacy deep link: /edit/context redirects to .../edit/access.
      await authedPage.goto(`/connectors/${encodeURIComponent(serverName)}/edit/context`)
      await authedPage.waitForURL(`**/connectors/${serverName}/edit/access`, {
        timeout: 15_000,
      })
      await expect(
        authedPage.getByRole('heading', { name: 'Agent access', exact: true })
      ).toBeVisible({ timeout: 15_000 })
    } finally {
      await controlApi.ensureMcpServerDeleted(serverName)
      await controlApi.ensureHostDeleted(agentName)
      await controlApi.ensureContextDeleted(contextName)
    }
  })
})
