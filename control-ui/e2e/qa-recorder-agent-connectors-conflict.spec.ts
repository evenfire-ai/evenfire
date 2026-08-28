// control-ui/e2e/qa-recorder-agent-connectors-conflict.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the optimistic-concurrency guard on the agent Connectors tab:
// the page loads a context resourceVersion, an out-of-band Control API PUT
// bumps that version behind the page's back, and the next "Add connector"
// save fails with HTTP 409 — surfacing the reload-guidance error banner
// instead of silently overwriting the winner. Reloading the page picks up
// the fresh resourceVersion and the retried add lands ("Connectors
// updated."). The seeded context, MCP servers, and host are deleted via the
// Control API in a finally (host first, then servers and context).
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

type ContextRead = {
  metadata?: { resourceVersion?: string }
  spec?: Record<string, unknown>
}

// The single-resource GET returns the bare Context; tolerate an `{ item }`
// envelope so the journey survives either wire shape.
type ContextReadEnvelope = ContextRead & { item?: ContextRead }

test.describe('optional QA recorder: Control UI agent connectors conflict', () => {
  test('optional QA recorder: Control UI agent connectors conflict journey', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a context, MCP servers, and a host.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const agentName = uniqueE2EName('qa-agent-conflict-host')
    const contextName = uniqueE2EName('qa-agent-conflict-ctx')
    // The context starts with no servers so both seeded catalog servers are
    // pickable in the "Add connector" dialog on every retry.
    const serverOne = uniqueE2EName('qa-agent-conflict-srv-a')
    const serverTwo = uniqueE2EName('qa-agent-conflict-srv-b')

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

      // Seed: empty context, two catalog servers, and the host bound to the
      // context.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: `QA recorder agent-connectors conflict fixture for ${agentName}`,
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      for (const serverName of [serverOne, serverTwo]) {
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

      // Open the agent's Connectors tab. The empty-state cell proves the
      // context (and its resourceVersion) finished loading before the dialog
      // opens.
      await page.goto(`${CONTROL_UI_URL}/agents/${agentName}/connectors`)
      await expect(page.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('No connectors attached yet.')).toBeVisible({ timeout: 20_000 })

      // Open the "Add connector" dialog — this loads the available servers
      // but does NOT submit yet.
      await page.getByRole('button', { name: 'Add connector', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add connectors' })
      await expect(dialog).toBeVisible({ timeout: 20_000 })
      await expect(dialog.getByRole('option', { name: serverOne, exact: true })).toBeVisible({
        timeout: 20_000,
      })

      // Mutate the context out-of-band: a fresh GET carries the current
      // resourceVersion, and ONE same-spec PUT bumps it server-side, so the
      // version the page loaded is now stale.
      const currentRes = await api<ContextReadEnvelope>(
        page.request,
        'GET',
        `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
      )
      expect(currentRes.status, `get context: ${JSON.stringify(currentRes.data)}`).toBe(200)
      const currentContext = currentRes.data.item ?? currentRes.data
      const resourceVersion = String(currentContext.metadata?.resourceVersion || '')
      expect(resourceVersion, 'context resourceVersion before the out-of-band PUT').toBeTruthy()
      const bumpRes = await api(
        page.request,
        'PUT',
        `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`,
        {
          metadata: { resourceVersion },
          spec: currentContext.spec ?? {},
        }
      )
      expect(
        bumpRes.status,
        `out-of-band context PUT: ${JSON.stringify(bumpRes.data)}`
      ).toBeLessThan(300)

      // Back in the UI, pick an option and confirm. The dialog's confirm
      // button repeats the page-level opener's "Add connector" label, so the
      // lookup stays scoped to the dialog.
      await dialog.getByRole('option', { name: serverOne, exact: true }).click()
      await dialog.getByRole('button', { name: 'Add connector', exact: true }).click()

      // The save 409s: the error banner shows the reload guidance at the top
      // of the page, and the dialog stays open with the draft preserved.
      await expect(
        page.locator('.cu-banner--error').filter({
          hasText:
            'This agent’s connectors changed since they were loaded. Reload the agent and try again.',
        })
      ).toBeVisible({ timeout: 20_000 })
      await expect(dialog).toBeVisible()
      await expect(page.getByText('Connectors updated.')).toHaveCount(0)
      await screenshotAndLog(page, testInfo, 'agent-connectors-conflict-banner')

      // Recovery: reloading the page picks up the fresh resourceVersion.
      await page.reload()
      await expect(page.getByText(`Agent: ${agentName}`)).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText('No connectors attached yet.')).toBeVisible({ timeout: 20_000 })

      // The retried add succeeds.
      await page.getByRole('button', { name: 'Add connector', exact: true }).click()
      const retryDialog = page.getByRole('dialog', { name: 'Add connectors' })
      await expect(retryDialog).toBeVisible({ timeout: 20_000 })
      await retryDialog.getByRole('option', { name: serverOne, exact: true }).click()
      await retryDialog.getByRole('button', { name: 'Add connector', exact: true }).click()

      await expect(page.getByText('Connectors updated.')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('row', { name: new RegExp(serverOne) })).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, 'agent-connectors-conflict-recovered')
    } finally {
      // Best-effort cleanup; the disposable environment tolerates leftovers.
      // The host must go before its context.
      try {
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverOne)}`
        )
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(serverTwo)}`
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
