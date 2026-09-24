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
import { type SecretIdentity, requireSecretIdentity } from '../test-utils/secretIdentity'
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
    let cleanupIdentity: SecretIdentity | null = null
    // Cleanup deletes only what this run actually created; see the finally.
    let secretCreated = false
    let contextCreated = false
    let connectorCreated = false
    let primaryFailure: unknown = null
    const contextName = uniqueE2EName('demo-context')
    const connectorName = uniqueE2EName('demo-connector')
    const secretName = uniqueE2EName('demo-secret')
    const secretKey = 'api-key'
    const envVar = 'DEMO_API_KEY'

    try {
      await test.step('sign in through the Control UI', async () => {
        await loginThroughUi(page, credentials)
        await humanPause(page)
      })

      await test.step('stage a managed connector + Secret (API preconditions)', async () => {
        const s = await api(page.request, 'POST', '/api/v1/admin/mcp-secrets', {
          name: secretName,
          data: { [secretKey]: 'initial-value-123' },
        })
        expect(s.status, `Secret: ${JSON.stringify(s.data)}`).toBeLessThan(300)
        secretCreated = true
        cleanupIdentity = requireSecretIdentity(s.data, 'stage cleanup identity')

        const c = await api(page.request, 'POST', '/api/v1/admin/contexts', {
          metadata: { name: contextName },
          spec: { contextId: contextName, description: 'demo rotation context', mcpServers: [] },
        })
        expect(c.status, `context: ${JSON.stringify(c.data)}`).toBeLessThan(300)
        contextCreated = true
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
        connectorCreated = true
      })

      await test.step('navigate: sidebar "Connectors" -> connectors list', async () => {
        await humanClick(
          page,
          page.getByRole('link', { name: 'Installed Connectors', exact: true })
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
        const rotateResponse = page.waitForResponse(
          response =>
            response.request().method() === 'PUT' &&
            response.url().includes(encodeURIComponent(secretName)),
          { timeout: 30_000 }
        )
        await humanClick(
          page,
          dialog.getByRole('button', { name: 'Rotate & restart', exact: true })
        )
        const rotated = await rotateResponse
        expect(rotated.status()).toBe(200)
        cleanupIdentity = requireSecretIdentity(await rotated.json(), 'rotate cleanup identity')
      })

      await test.step('watch the rollout reach "Credentials rotated"', async () => {
        await expect(page.getByText(/Rotating credentials/)).toBeVisible({ timeout: 20_000 })
        await expect(page.getByText(/Credentials rotated\./)).toBeVisible({ timeout: 185_000 })
        // The transitory-False -> failure defect (B1) must not appear.
        await expect(page.getByText(/Rotation failed:/)).toHaveCount(0)
        // Linger on the success banner so the recording clearly shows it.
        await humanPause(page, 3000, 4000)
      })
    } catch (err) {
      primaryFailure = err
      throw err
    } finally {
      // A `throw` or a failed `expect` inside `finally` REPLACES the exception
      // the body raised, so a run that died while staging used to be reported
      // as "cleanup connector: expected 200, received 404". Collect every
      // cleanup problem instead, and let it fail the test only when the body
      // itself passed; otherwise log it next to the real failure.
      const cleanupFailures: string[] = []
      // Order matters: the connector references the Secret, and the MCP
      // Secret DELETE refuses a Secret a live connector still uses.
      if (connectorCreated) {
        const deleteConnector = await api(
          page.request,
          'DELETE',
          `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
        )
        if (deleteConnector.status !== 200) {
          cleanupFailures.push(`connector ${connectorName}: HTTP ${deleteConnector.status}`)
        }
      }
      if (secretCreated) {
        if (!cleanupIdentity) {
          cleanupFailures.push(
            `Secret ${secretName}: created without a CAS identity; delete it by hand`
          )
        } else {
          const deleteSecret = await api(
            page.request,
            'DELETE',
            `/api/v1/admin/mcp-secrets/${encodeURIComponent(secretName)}`,
            cleanupIdentity
          )
          if (deleteSecret.status !== 200) {
            cleanupFailures.push(`Secret ${secretName}: HTTP ${deleteSecret.status}`)
          }
        }
      }
      if (contextCreated) {
        const deleteContext = await api(
          page.request,
          'DELETE',
          `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
        )
        if (deleteContext.status !== 200) {
          cleanupFailures.push(`context ${contextName}: HTTP ${deleteContext.status}`)
        }
      }
      if (cleanupFailures.length > 0) {
        const message = `cleanup failed: ${cleanupFailures.join('; ')}`
        if (primaryFailure) {
          console.error(
            `${message} (after test failure: ${
              primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure)
            })`
          )
        } else {
          throw new Error(message)
        }
      }
    }
  })
})
