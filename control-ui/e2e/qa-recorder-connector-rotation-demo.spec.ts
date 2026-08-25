// Human demo of the issue #223 credential-rotation journey, driven ENTIRELY
// through the UI so a recording reads like a cluster operator doing it by hand:
//   sign in -> sidebar "Connectors" -> expand the connector row -> "Edit" ->
//   scroll to "Update credentials" -> type the new value -> "Rotate credentials"
//   -> confirm "Rotate & restart" -> watch the rollout reach "Credentials rotated".
//
// Preconditions (Secret + context + a MANAGED connector on the mock MCP image)
// are staged via the Control API so the rotation reaches a genuine
// DeploymentReady=True (not the tolerated timeout). Recorded via the
// human-e2e-recorder skill (headed, slowMo, video). Opt-in: QA_RECORDER_CONFIRM_MUTATIONS=1.
import { expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  uniqueE2EName,
} from './qa-recorder-helpers'
import { humanClick, humanPause, humanType } from './support/human'

const MOCK_MCP_IMAGE = process.env.TEST_MOCK_MCP_IMAGE ?? 'clerum/mock-mcp-server:test'

test.describe('demo: Control UI credential-rotation journey', () => {
  test('a cluster operator rotates a connector credential through the UI', async ({ page }) => {
    test.setTimeout(300_000)
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'Human demo: stages a Secret-backed managed connector, rotates its credential through the UI, then deletes them.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('demo-context')
    const connectorName = uniqueE2EName('demo-connector')
    const secretName = uniqueE2EName('demo-secret')
    const secretKey = 'api-key'
    const envVar = 'DEMO_API_KEY'
    let createdSecretIdentity: { uid: string; resourceVersion: string } | undefined

    try {
      await test.step('sign in through the Control UI', async () => {
        await loginThroughUi(page, credentials)
        await humanPause(page)
      })

      await test.step('stage a managed connector + Secret (API preconditions)', async () => {
        const s = await api<{ uid?: unknown; resourceVersion?: unknown }>(
          page.request,
          'POST',
          '/api/v1/admin/mcp-secrets',
          {
            name: secretName,
            data: { [secretKey]: 'initial-value-123' },
          }
        )
        expect(s.status, `Secret: ${JSON.stringify(s.data)}`).toBeLessThan(300)
        expect(typeof s.data.uid, 'created object uid').toBe('string')
        expect(typeof s.data.resourceVersion, 'created object resourceVersion').toBe('string')
        createdSecretIdentity = {
          uid: s.data.uid as string,
          resourceVersion: s.data.resourceVersion as string,
        }
        const c = await api(page.request, 'POST', '/api/v1/admin/contexts', {
          metadata: { name: contextName },
          spec: { contextId: contextName, description: 'demo rotation context', mcpServers: [] },
        })
        expect(c.status, `context: ${JSON.stringify(c.data)}`).toBeLessThan(300)
        const srv = await api(page.request, 'POST', '/api/v1/admin/mcp-servers', {
          metadata: { name: connectorName },
          spec: {
            image: MOCK_MCP_IMAGE,
            contextRef: contextName,
            description: 'issue #223 credential-rotation demo connector',
            transport: {
              type: 'streamableHttp',
              url: `http://${connectorName}.mcp-server.svc.cluster.local:3000/mcp`,
              port: 3000,
            },
            healthCheck: { port: 3001 },
            envSecret: { name: secretName, keys: [{ secretKey, envVar }] },
            enabled: true,
          },
        })
        expect(srv.status, `connector: ${JSON.stringify(srv.data)}`).toBeLessThan(300)
      })

      await test.step('navigate: sidebar "Connectors" -> connectors list', async () => {
        await humanClick(
          page,
          page.getByRole('link', { name: 'Installed connectors', exact: true })
        )
        await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
        await humanPause(page)
      })

      await test.step('expand the connector row and open its Edit screen', async () => {
        const expandBtn = page.getByRole('button', { name: `Expand connector ${connectorName}` })
        await expect(expandBtn).toBeVisible({ timeout: 30_000 })
        await humanClick(page, expandBtn)
        await humanClick(
          page,
          page.getByRole('button', { name: `Edit connector ${connectorName}` })
        )
        await expect(
          page.getByRole('heading', { name: `Edit Connector: ${connectorName}`, exact: true })
        ).toBeVisible({ timeout: 20_000 })
        await humanPause(page)
      })

      await test.step('open the Credentials tab and read the key mapping', async () => {
        await humanClick(page, page.getByRole('tab', { name: 'Credentials', exact: true }))
        await expect(page.getByText('Update credentials', { exact: true })).toBeVisible({
          timeout: 20_000,
        })
        const input = page.locator(`#mcp-cred-${secretKey}`)
        await expect(input).toBeVisible({ timeout: 20_000 })
        // Names-only: masked, empty input; the screen never shows a stored value.
        await expect(input).toHaveAttribute('type', 'password')
        await expect(input).toHaveValue('')
        await humanPause(page)
      })

      await test.step('type the new credential value', async () => {
        await humanType(page, page.locator(`#mcp-cred-${secretKey}`), 'rotated-demo-value-456')
      })

      await test.step('rotate & confirm the restart', async () => {
        await humanClick(
          page,
          page.getByRole('button', { name: 'Rotate credentials', exact: true })
        )
        const dialog = page.getByRole('alertdialog', { name: 'Rotate credentials' })
        await expect(dialog).toBeVisible({ timeout: 20_000 })
        await humanPause(page)
        const rotateResponsePromise = page.waitForResponse(response => {
          return (
            response.request().method() === 'PUT' &&
            response.url().includes(`/admin/mcp-secrets/${encodeURIComponent(secretName)}`)
          )
        })
        await humanClick(
          page,
          dialog.getByRole('button', { name: 'Rotate & restart', exact: true })
        )
        const rotateResponse = await rotateResponsePromise
        expect(rotateResponse.status()).toBeLessThan(300)
        const rotated = (await rotateResponse.json()) as {
          uid?: unknown
          resourceVersion?: unknown
        }
        expect(typeof rotated.uid, 'rotated object uid').toBe('string')
        expect(typeof rotated.resourceVersion, 'rotated object resourceVersion').toBe('string')
        createdSecretIdentity = {
          uid: rotated.uid as string,
          resourceVersion: rotated.resourceVersion as string,
        }
      })

      await test.step('watch the rollout reach "Credentials rotated"', async () => {
        await expect(page.getByText(/Rotating credentials/)).toBeVisible({ timeout: 20_000 })
        await expect(page.getByText(/Credentials rotated\./)).toBeVisible({ timeout: 185_000 })
        // The transitory-False -> failure defect (B1) must not appear.
        await expect(page.getByText(/Rotation failed:/)).toHaveCount(0)
        // Linger on the success banner so the recording clearly shows it.
        await humanPause(page, 3000, 4000)
      })
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      if (createdSecretIdentity) {
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-secrets/${encodeURIComponent(secretName)}`,
          createdSecretIdentity
        )
      }
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
