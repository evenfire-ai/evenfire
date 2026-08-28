// control-ui/e2e/qa-recorder-agent-connectors.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the agent connectors story end to end: the Agents list hover
// card (neutral "Connectors" heading + server names, never the private
// context slug), the click-through to the agent's Connectors tab, the
// "Add connector" picker dialog, and the kebab "Remove connector" confirm.
// The seeded context, MCP servers, and host are deleted via the Control API
// in a finally (host first, then servers and context).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the recorder").
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

test.describe('optional QA recorder: Control UI agent connectors', () => {
  test('optional QA recorder: Control UI agent connectors journey', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a context, MCP servers, and a host.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const agentName = uniqueE2EName('qa-agent-conn-host')
    const contextName = uniqueE2EName('qa-agent-conn-ctx')
    // Two servers are attached to the agent's context so the hover card and
    // the Connectors tab have real rows to show. A third catalog-only server
    // exists because the "Add connector" picker hides connectors the agent
    // already has — the add beat needs one that is not yet attached.
    const serverAttachedOne = uniqueE2EName('qa-agent-conn-srv-a')
    const serverAttachedTwo = uniqueE2EName('qa-agent-conn-srv-b')
    const serverCatalogOnly = uniqueE2EName('qa-agent-conn-srv-c')

    async function createMcpServer(serverName: string): Promise<void> {
      const res = await api(page.request, 'POST', '/api/v1/admin/mcp-servers', {
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
      expect(res.status, `create mcp-server: ${JSON.stringify(res.data)}`).toBeLessThan(300)
    }

    try {
      await loginThroughUi(page, credentials)

      // Seed: context carrying the two attached servers, three catalog
      // servers, and the host bound to the context.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: `QA recorder agent-connectors fixture for ${agentName}`,
          mcpServers: [serverAttachedOne, serverAttachedTwo],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      for (const serverName of [serverAttachedOne, serverAttachedTwo, serverCatalogOnly]) {
        await createMcpServer(serverName)
      }

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

      // (a) Agents list row: hover the connectors count to reveal the card.
      // Login already landed on /agents (pre-seed, empty); a sidebar click on
      // the active route would not remount or refetch, so navigate fresh.
      await page.goto(`${CONTROL_UI_URL}/agents`)
      await expect(page.getByRole('columnheader', { name: 'Connectors', exact: true })).toBeVisible(
        { timeout: 20_000 }
      )

      const row = page.getByRole('row', { name: new RegExp(agentName) })
      await expect(row).toBeVisible({ timeout: 20_000 })

      // The count reflects the context enrichment once the contexts fetch
      // resolves — wait for the concrete value, not just the button.
      const countButton = row.locator('.cu-host-connectors-count')
      await expect(countButton).toHaveText('2', { timeout: 20_000 })

      await countButton.hover()
      const tooltip = page.getByRole('tooltip')
      await expect(tooltip).toBeVisible({ timeout: 20_000 })
      await expect(tooltip).toContainText('Connectors')
      await expect(tooltip).toContainText(serverAttachedOne)
      await expect(tooltip).toContainText(serverAttachedTwo)

      // The private context slug is an implementation detail — never rendered.
      const bodyText = await page.innerText('body')
      expect(bodyText).not.toContain(contextName)
      await screenshotAndLog(page, testInfo, 'agent-connectors-hover-card')

      // (b) Clicking the count opens the agent's Connectors tab.
      await countButton.click()
      await expect(page).toHaveURL(new RegExp(`/agents/${agentName}/connectors/?$`), {
        timeout: 20_000,
      })
      await expect(page.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('row', { name: new RegExp(serverAttachedOne) })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('row', { name: new RegExp(serverAttachedTwo) })).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, 'agent-connectors-tab')

      // (c) Add connector — the dialog offers catalog servers not yet
      // attached; its confirm button repeats the "Add connector" label.
      await page.getByRole('button', { name: 'Add connector', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add connectors' })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(
        dialog.getByRole('option', { name: serverCatalogOnly, exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await dialog.getByRole('option', { name: serverCatalogOnly, exact: true }).click()
      await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()

      await expect(page.getByText('Connectors updated.').last()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('row', { name: new RegExp(serverCatalogOnly) })).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, 'agent-connectors-added')

      // (d) Remove connector — kebab per connector row, then the confirm dialog.
      await page.getByRole('button', { name: `Actions for connector ${serverCatalogOnly}` }).click()
      await page.getByRole('menuitem', { name: 'Remove connector' }).click()
      const confirmDialog = page.getByRole('alertdialog', {
        name: 'Remove connector from this agent?',
      })
      await expect(confirmDialog).toBeVisible({ timeout: 20_000 })
      await confirmDialog.getByRole('button', { name: 'Remove connector' }).click()

      await expect(page.getByText('Connectors updated.').last()).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('row', { name: new RegExp(serverCatalogOnly) })).toHaveCount(0)

      // The private context slug never renders on this page either.
      await expect(page.getByText(contextName)).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'agent-connectors-removed')
    } finally {
      // Best-effort cleanup; the disposable environment tolerates leftovers.
      // The host must go before its context.
      try {
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverAttachedOne)}`
        )
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverAttachedTwo)}`
        )
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverCatalogOnly)}`
        )
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
