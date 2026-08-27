/**
 * Control UI — Connectors list agent access
 *
 * /connectors expands each connector row into an Access grid where the
 * Agents group is operator-managed: per-agent remove (guarded by a shared-
 * scope confirm when one context backs several agents) and an "Add agents"
 * picker. Context slugs are the write target, never rendered.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Connectors agent access', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('manages agent access from the expanded connector row, including the shared-context confirm', async ({
    authedPage,
  }) => {
    test.setTimeout(240_000)
    const stamp = Date.now()
    const serverName = `e2e-caa-srv-${stamp}`
    const contextA = `e2e-caa-ctx-a-${stamp}`
    const contextB = `e2e-caa-ctx-b-${stamp}`
    const agentA = `e2e-caa-agent-a-${stamp}`
    const agentB1 = `e2e-caa-agent-b1-${stamp}`
    const agentB2 = `e2e-caa-agent-b2-${stamp}`
    try {
      // PRECONDITION (labeled setup): one connector carried by two private
      // contexts — ctxA backs ONE agent, ctxB backs TWO (shared scope), so
      // removing from ctxB must surface the "Remove Connector Access"
      // confirm while removing from ctxA must not.
      await controlApi.createMcpServer({
        metadata: { name: serverName },
        spec: {
          image: 'clerum/mock-mcp-server:test',
          contextRef: contextA,
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
        metadata: { name: contextA },
        spec: {
          contextId: contextA,
          description: 'Single-agent connector scope',
          mcpServers: [serverName],
        },
      })
      await controlApi.createContext({
        metadata: { name: contextB },
        spec: {
          contextId: contextB,
          description: 'Shared two-agent connector scope',
          mcpServers: [serverName],
        },
      })
      for (const [agentName, contextRef] of [
        [agentA, contextA],
        [agentB1, contextB],
        [agentB2, contextB],
      ] as const) {
        await controlApi.createHost({
          metadata: { name: agentName },
          spec: {
            host: agentName,
            contextRef,
            secretRef: '',
            channels: [],
            model: { provider: 'openai', name: 'gpt-5.4-mini' },
          },
        })
      }

      await authedPage.goto('/connectors')
      await expect(
        authedPage.getByText('Browse connector deployments and agent access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      const expandConnector = async () => {
        const row = authedPage.getByRole('row', { name: new RegExp(serverName) })
        await expect(row).toBeVisible({ timeout: 20_000 })
        await row.click()
        await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })
        const detail = authedPage.locator('.cu-connector-detail')
        await expect(detail).toBeVisible({ timeout: 10_000 })
        return detail
      }

      // Expanded Access section: Agents/Teams/Users groups list all three
      // agent display names — and no context slug anywhere on the page.
      let detail = await expandConnector()
      for (const groupTitle of ['Agents', 'Teams', 'Users']) {
        await expect(detail.getByRole('heading', { name: groupTitle, exact: true })).toBeVisible()
      }
      for (const agentName of [agentA, agentB1, agentB2]) {
        await expect(detail.getByText(agentName, { exact: true })).toBeVisible()
      }
      const bodyText = await authedPage.innerText('body')
      expect(bodyText).not.toContain(contextA)
      expect(bodyText).not.toContain(contextB)

      // Remove the single-agent binding — no confirm dialog, direct toast.
      await detail
        .getByRole('button', { name: `Remove connector ${serverName} from agent ${agentA}` })
        .click()
      await expect(
        authedPage.getByText(`Connector ${serverName} removed from ${agentA}.`)
      ).toBeVisible({ timeout: 20_000 })

      // Re-grant agentA through the "Add agents" picker dialog.
      await authedPage.reload()
      detail = await expandConnector()
      await detail.getByRole('button', { name: 'Add agents' }).click()
      const grantDialog = authedPage.getByRole('dialog', {
        name: 'Give agents access to this connector',
      })
      await expect(grantDialog).toBeVisible({ timeout: 10_000 })
      await expect(grantDialog.getByLabel('Agents')).toBeVisible()
      await grantDialog.getByRole('option', { name: agentA, exact: true }).click()
      await grantDialog.getByRole('button', { name: 'Add to agent', exact: true }).click()
      await expect(
        authedPage.getByText(`Connector ${serverName} added to agent ${agentA}.`)
      ).toBeVisible({ timeout: 20_000 })

      // Remove one agent of the shared pair — the confirm dialog guards the
      // change that would strip both agents at once.
      await authedPage.reload()
      detail = await expandConnector()
      await detail
        .getByRole('button', { name: `Remove connector ${serverName} from agent ${agentB1}` })
        .click()
      const sharedConfirm = authedPage.getByRole('alertdialog', {
        name: 'Remove Connector Access',
      })
      await expect(sharedConfirm).toBeVisible({ timeout: 10_000 })
      await sharedConfirm.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(
        authedPage.getByText(`Connector ${serverName} removed from 2 agents.`)
      ).toBeVisible({ timeout: 20_000 })
    } finally {
      await controlApi.ensureMcpServerDeleted(serverName)
      await controlApi.ensureHostDeleted(agentA)
      await controlApi.ensureHostDeleted(agentB1)
      await controlApi.ensureHostDeleted(agentB2)
      await controlApi.ensureContextDeleted(contextA)
      await controlApi.ensureContextDeleted(contextB)
    }
  })
})
