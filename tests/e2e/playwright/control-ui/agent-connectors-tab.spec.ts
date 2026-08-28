/**
 * Control UI — Agent detail connectors tab
 *
 * /agents/<name>/connectors manages the agent's connector set: "Add
 * connector" opens a picker dialog over the MCP-server catalog, and each
 * attached connector has a kebab "Remove connector" action behind a confirm
 * dialog. The agent's private context slug never renders on the page.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

test.describe('Control UI — Agent detail connectors tab', () => {
  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('adds and removes a connector through the tab UI without exposing the context slug', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    const stamp = Date.now()
    const agentName = `e2e-act-agent-${stamp}`
    const contextName = `e2e-act-ctx-${stamp}`
    const serverOne = `e2e-act-srv-a-${stamp}`
    const serverTwo = `e2e-act-srv-b-${stamp}`
    try {
      // PRECONDITION (labeled setup): an empty private context for the agent
      // (the tab writes connector sets here), two catalog servers the picker
      // can offer, and the host binding them together.
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
          description: `Connectors-tab fixture for ${agentName}`,
          mcpServers: [],
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

      await authedPage.goto(`/agents/${encodeURIComponent(agentName)}/connectors`)
      await expect(authedPage.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByText('No connectors attached yet.')).toBeVisible({
        timeout: 15_000,
      })

      // Add connector — the dialog lists the MCP-server catalog as options;
      // its confirm button repeats the "Add connector" label.
      await authedPage.getByRole('button', { name: 'Add connector', exact: true }).click()
      const dialog = authedPage.getByRole('dialog', { name: 'Add connectors' })
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await expect(dialog.getByRole('option', { name: serverOne, exact: true })).toBeVisible({
        timeout: 15_000,
      })
      await expect(dialog.getByRole('option', { name: serverTwo, exact: true })).toBeVisible()
      await dialog.getByRole('option', { name: serverOne, exact: true }).click()
      await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()

      await expect(authedPage.getByText('Connectors updated.')).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByRole('row', { name: new RegExp(serverOne) })).toBeVisible({
        timeout: 15_000,
      })

      // Remove connector — kebab per connector row, then the confirm dialog.
      await authedPage.getByRole('button', { name: `Actions for connector ${serverOne}` }).click()
      await authedPage.getByRole('menuitem', { name: 'Remove connector' }).click()
      const confirmDialog = authedPage.getByRole('alertdialog', {
        name: 'Remove connector from this agent?',
      })
      await expect(confirmDialog).toBeVisible({ timeout: 10_000 })
      await confirmDialog.getByRole('button', { name: 'Remove connector' }).click()

      await expect(authedPage.getByText('Connectors updated.')).toBeVisible({ timeout: 15_000 })
      await expect(authedPage.getByRole('row', { name: new RegExp(serverOne) })).toHaveCount(0)

      // The private context slug never renders on the page.
      await expect(authedPage.getByText(contextName)).toHaveCount(0)
    } finally {
      await controlApi.ensureHostDeleted(agentName)
      await controlApi.ensureMcpServerDeleted(serverOne)
      await controlApi.ensureMcpServerDeleted(serverTwo)
      await controlApi.ensureContextDeleted(contextName)
    }
  })
})
