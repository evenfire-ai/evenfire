// control-ui/e2e/qa-recorder-connectors-agent-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the shared-scope connector access story on the Installed
// Connectors list: expanding a connector row reveals the Agents/Teams/Users
// access grid (display names only, never the private context slugs), a
// single-agent removal lands a direct toast, the "Add agents" picker
// re-grants access, and removing one agent of a shared two-agent context is
// guarded by the "Remove Connector Access" confirm. The seeded server,
// hosts, and contexts are deleted via the Control API in a finally
// (server and hosts before contexts).
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

test.describe('optional QA recorder: Control UI connectors agent access', () => {
  test('optional QA recorder: Control UI connectors agent access journey', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes MCP server, host, and context resources.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const serverName = uniqueE2EName('qa-caa-srv')
    const contextA = uniqueE2EName('qa-caa-ctx-a')
    const contextB = uniqueE2EName('qa-caa-ctx-b')
    const agentA = uniqueE2EName('qa-caa-agent-a')
    const agentB1 = uniqueE2EName('qa-caa-agent-b1')
    const agentB2 = uniqueE2EName('qa-caa-agent-b2')

    async function createHost(agentName: string, contextRef: string): Promise<void> {
      const res = await api(page.request, 'POST', '/api/v1/admin/hosts', {
        metadata: { name: agentName },
        spec: {
          host: agentName,
          contextRef,
          secretRef: '',
          channels: [],
        },
      })
      expect(res.status, `create host: ${JSON.stringify(res.data)}`).toBeLessThan(300)
    }

    try {
      await loginThroughUi(page, credentials)

      // Seed: one connector carried by two private contexts — ctxA backs ONE
      // agent, ctxB backs TWO (shared scope), so removing from ctxB must
      // surface the "Remove Connector Access" confirm while removing from
      // ctxA must not.
      const serverRes = await api(page.request, 'POST', '/api/v1/admin/mcp-servers', {
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
      expect(serverRes.status, `create mcp-server: ${JSON.stringify(serverRes.data)}`).toBeLessThan(
        300
      )

      const ctxARes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextA },
        spec: {
          contextId: contextA,
          description: 'Single-agent connector scope',
          mcpServers: [serverName],
        },
      })
      expect(ctxARes.status, `create context A: ${JSON.stringify(ctxARes.data)}`).toBeLessThan(300)

      const ctxBRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextB },
        spec: {
          contextId: contextB,
          description: 'Shared two-agent connector scope',
          mcpServers: [serverName],
        },
      })
      expect(ctxBRes.status, `create context B: ${JSON.stringify(ctxBRes.data)}`).toBeLessThan(300)

      await createHost(agentA, contextA)
      await createHost(agentB1, contextB)
      await createHost(agentB2, contextB)

      await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
      await expect(page).toHaveURL(/\/connectors\/?$/, { timeout: 20_000 })
      await expect(
        page.getByText('Browse connector deployments and agent access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      const expandConnector = async () => {
        const row = page.getByRole('button', { name: new RegExp(`Expand connector ${serverName}`) })
        await expect(row).toBeVisible({ timeout: 20_000 })
        await row.click()
        const collapse = page.getByRole('button', {
          name: new RegExp(`Collapse connector ${serverName}`),
        })
        await expect(collapse).toBeVisible({ timeout: 20_000 })
        const detail = page.locator('.cu-connector-detail')
        await expect(detail).toBeVisible({ timeout: 20_000 })
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
      const bodyText = await page.innerText('body')
      expect(bodyText).not.toContain(contextA)
      expect(bodyText).not.toContain(contextB)
      await screenshotAndLog(page, testInfo, 'connectors-agent-access-expanded')

      // Remove the single-agent binding — no confirm dialog, direct toast.
      await detail
        .getByRole('button', { name: `Remove connector ${serverName} from agent ${agentA}` })
        .click()
      await expect(page.getByText(`Connector ${serverName} removed from ${agentA}.`)).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, 'connectors-agent-access-removed-single')

      // Re-grant agentA through the "Add agents" picker dialog.
      await page.reload()
      detail = await expandConnector()
      await detail.getByRole('button', { name: 'Add agents' }).click()
      const grantDialog = page.getByRole('dialog', {
        name: 'Give agents access to this connector',
      })
      await expect(grantDialog).toBeVisible({ timeout: 20_000 })
      await expect(grantDialog.getByLabel('Agents')).toBeVisible()
      await grantDialog.getByRole('option', { name: agentA, exact: true }).click()
      await grantDialog.getByRole('button', { name: 'Add to agent', exact: true }).click()
      await expect(page.getByText(`Connector ${serverName} added to agent ${agentA}.`)).toBeVisible(
        { timeout: 20_000 }
      )
      await screenshotAndLog(page, testInfo, 'connectors-agent-access-added-back')

      // Remove one agent of the shared pair — the confirm dialog guards the
      // change that would strip both agents at once.
      await page.reload()
      detail = await expandConnector()
      await detail
        .getByRole('button', { name: `Remove connector ${serverName} from agent ${agentB1}` })
        .click()
      const sharedConfirm = page.getByRole('alertdialog', {
        name: 'Remove Connector Access',
      })
      await expect(sharedConfirm).toBeVisible({ timeout: 20_000 })
      await sharedConfirm.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(page.getByText(`Connector ${serverName} removed from 2 agents.`)).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, 'connectors-agent-access-removed-shared')
    } finally {
      // Best-effort cleanup; the disposable environment tolerates leftovers.
      // The server and hosts must go before the contexts.
      try {
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverName)}`
        )
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentA)}`)
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentB1)}`)
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentB2)}`)
        await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextA)}`)
        await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextB)}`)
      } catch {
        // Ignore cleanup failures.
      }
    }
  })
})
