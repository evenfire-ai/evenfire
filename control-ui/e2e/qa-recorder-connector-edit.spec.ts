// control-ui/e2e/qa-recorder-connector-edit.spec.ts
//
// MUTATING journey: creates a context + stdio discovery connector (reusing the
// spec-2 creation flow inline), then edits the connector to add external CIDR
// egress. Guarded by QA_RECORDER_CONFIRM_MUTATIONS; connector then context are
// deleted via the Control API in a finally.
import { type Page, expect, test } from '@playwright/test'
import { requireSecretIdentity, type SecretIdentity } from '../test-utils/secretIdentity'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  directApi,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

// The rotation journey stages its connector on the mock MCP image (mirroring the
// T2 integration `localMcpServerYaml` fixture) so the HCC rolls out a REAL
// Deployment the UI can poll to a genuine `DeploymentReady=True` — an unmanaged
// or non-existent image would never converge, only time out.
const MOCK_MCP_IMAGE = process.env.TEST_MOCK_MCP_IMAGE ?? 'clerum/mock-mcp-server:test'

// The connector-form's Transport Type and Managed selects are not label-associated,
// so use their visible field label as the stable local scope for those controls.
async function fieldSelect(page: Page, fieldLabelText: string, value: string): Promise<void> {
  await page.getByText(fieldLabelText, { exact: true }).locator('..').getByRole('combobox').selectOption(value)
}

async function createEmptyContext(page: Page, contextName: string): Promise<void> {
  await page.getByRole('link', { name: 'Contexts', exact: true }).click()
  await expect(page).toHaveURL(/\/contexts$/, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Create context', exact: true }).click()
  await expect(page).toHaveURL(/\/contexts\/new$/, { timeout: 20_000 })
  await page.getByLabel('Context name').fill(contextName)
  await page
    .getByPlaceholder('Human-readable context description')
    .fill('QA recorder temporary context')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  await expect(
    page
      .getByText('No connectors found.', { exact: true })
      .or(page.getByPlaceholder('Search connectors...'))
  ).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Create context', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/contexts/${contextName}$`), { timeout: 20_000 })
  await expect(
    page.getByText('Review details, manage connectors, agents, teams, and members.', {
      exact: true,
    })
  ).toBeVisible({ timeout: 20_000 })
}

async function createDiscoveryConnector(
  page: Page,
  connectorName: string,
  contextName: string
): Promise<void> {
  await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Connector actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create connector', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })

  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('qa-recorder/example:dev')
  await page
    .getByPlaceholder('Optional description of this connector')
    .fill('QA recorder discovery-only connector')

  await page.getByText('Advanced options', { exact: true }).click()
  await fieldSelect(page, 'Transport Type', 'stdio')
  await expect(page.locator('input[type="number"]')).toHaveCount(0)
  await fieldSelect(page, 'Managed', 'false')
  await page.getByLabel('Egress mode').selectOption('exact-cidr')
  await page.getByLabel('Allowed CIDRs/IPs').fill('8.8.8.8/32')
  await page.getByLabel('Allowed ports').fill('443')

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  const contextDropdown = page.getByRole('button', { name: 'Context', exact: true })
  await expect(contextDropdown).toBeEnabled({ timeout: 20_000 })
  await contextDropdown.click()
  await expect(page.getByPlaceholder('Search contexts...')).toBeVisible({ timeout: 20_000 })
  const contextOption = page.getByRole('option', { name: contextName, exact: true })
  await expect(contextOption).toBeVisible({ timeout: 20_000 })
  await contextOption.click()

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  await expect(
    page.getByRole('radio', { name: /^No credentials required/ })
  ).toBeVisible({ timeout: 20_000 })
  await page.getByRole('radio', { name: /^No credentials required/ }).check()

  await page.getByRole('button', { name: 'Create connector', exact: true }).click()
  await expect(page.getByText('Connector created successfully.', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
}

async function openConnectorEditor(page: Page, connectorName: string): Promise<void> {
  await page.getByRole('button', { name: `Expand connector ${connectorName}` }).click()
  await page
    .getByRole('button', { name: `Actions for connector ${connectorName}`, exact: true })
    .click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
}

test.describe('optional QA recorder: Control UI connector edit', () => {
  test('records editing a discovery connector to add external CIDR egress', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes local context and connector resources.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-context')
    const connectorName = uniqueE2EName('qa-recorder-connector')

    try {
      await loginThroughUi(page, credentials)

      await createEmptyContext(page, contextName)
      await createDiscoveryConnector(page, connectorName, contextName)

      await openConnectorEditor(page, connectorName)
      await expect(
        page.getByRole('heading', { name: `Edit Connector: ${connectorName}`, exact: true })
      ).toBeVisible({ timeout: 20_000 })

      // Context is a read-only final tab. It mirrors the selected context's
      // Users, Teams, and Agents access preview without offering a mutation.
      await page.getByRole('tab', { name: 'Context', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Context access', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByLabel('Connector context').getByText(contextName)).toBeVisible()

      await page.getByRole('tab', { name: 'External Egress', exact: true }).click()

      // Image and Context are rendered as static read-only text (not editable inputs).
      const meta = page.locator('.cu-connector-edit-meta')
      await expect(meta).toBeVisible({ timeout: 20_000 })
      await expect(meta.getByText('qa-recorder/example:dev')).toBeVisible()
      await expect(meta.getByText(contextName)).toBeVisible()

      // External Egress: switch to exact-CIDR mode and add one public CIDR + port.
      // 8.8.8.8/32 is a valid public target; the model rejects private/doc ranges.
      await page.getByLabel('Egress mode').selectOption('exact-cidr')
      await page.getByLabel('Allowed CIDRs/IPs').fill('8.8.8.8/32')
      await page.getByLabel('Allowed ports').fill('443')

      await page.getByRole('button', { name: 'Save egress', exact: true }).click()
      await expect(
        page.getByText(`Connector ${connectorName} updated.`, { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-connector-edit')
    } finally {
      await directApi(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      await directApi(
        page.request,
        'DELETE',
        `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
      )
    }
  })

  // Issue #223: rotates a connector's credential through the "Update
  // credentials" section and rides the polling out to a terminal state.
  // Precondition setup stays outside the interaction under test, but
  // the rotation itself — filling the new value, confirming the restart
  // warning, saving, watching the status settle — is driven exclusively by
  // real user actions against the live control-api/HCC, never a direct PUT,
  // never a mocked backend, never a fixed delay.
  test('records rotating a connector credential and reaching a terminal rollout state', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates a context, a Secret-backed connector, rotates the credential through the UI, and deletes them all.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const contextName = uniqueE2EName('qa-recorder-context')
    const connectorName = uniqueE2EName('qa-recorder-connector')
    const secretName = uniqueE2EName('qa-recorder-secret')
    const secretKey = 'api-key'
    const envVar = 'QA_RECORDER_API_KEY'
    let cleanupIdentity: SecretIdentity | null = null

    try {
      await loginThroughUi(page, credentials)

      // Preconditions staged through the Control API (not the multi-step
      // create-form UI): the behavior UNDER TEST here is the rotation journey, so
      // the Secret + context + connector are set up out-of-band and the test
      // drives only the rotation through the UI. A MANAGED connector on the mock
      // image is used so the rotation reaches a real DeploymentReady terminal
      // state (an unmanaged connector has no Deployment to poll). This mirrors the
      // T2 integration `localMcpServerYaml` fixture.
      const secretRes = await api(page.request, 'POST', '/api/v1/admin/mcp-secrets', {
        name: secretName,
        data: { [secretKey]: 'initial-value-123' },
      })
      expect(secretRes.status, `create Secret: ${JSON.stringify(secretRes.data)}`).toBeLessThan(300)

      cleanupIdentity = requireSecretIdentity(secretRes.data, 'stage cleanup identity')

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder rotation context',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const srvRes = await api(page.request, 'POST', '/api/v1/admin/mcp-servers', {
        metadata: { name: connectorName },
        spec: {
          image: MOCK_MCP_IMAGE,
          contextRef: contextName,
          description: 'issue #223 credential-rotation e2e connector',
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
      expect(srvRes.status, `create connector: ${JSON.stringify(srvRes.data)}`).toBeLessThan(300)

      await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
      await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
      await openConnectorEditor(page, connectorName)
      await expect(
        page.getByRole('heading', { name: `Edit Connector: ${connectorName}`, exact: true })
      ).toBeVisible({ timeout: 20_000 })

      // The connector edit screen is split into tabs; the rotation flow lives
      // on the Credentials tab — navigate there via the visible tab.
      await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Update credentials', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      // The section names the Secret and the key -> env var mapping — names
      // only, never the stored value.
      await expect(page.getByText(secretName, { exact: true })).toBeVisible({ timeout: 20_000 })
      const mappingTable = page.locator('table', { hasText: secretKey })
      await expect(mappingTable).toBeVisible({ timeout: 20_000 })
      await expect(mappingTable.getByText(secretKey, { exact: true })).toBeVisible()
      await expect(mappingTable.getByText(envVar, { exact: true })).toBeVisible()
      await expect(page.getByText('initial-value-123')).toHaveCount(0)

      // Real user action: type into the masked, empty input — never
      // pre-filled with the stored value.
      const credentialInput = page.locator(`#mcp-cred-${secretKey}`)
      await expect(credentialInput).toBeVisible({ timeout: 20_000 })
      await expect(credentialInput).toHaveAttribute('type', 'password')
      await expect(credentialInput).toHaveValue('')
      await credentialInput.fill('rotated-value-456')

      await page.getByRole('button', { name: 'Rotate credentials', exact: true }).click()

      // Explicit confirmation gate before anything is sent to the server.
      const confirmDialog = page.getByRole('alertdialog', { name: 'Rotate credentials' })
      await expect(confirmDialog).toBeVisible({ timeout: 20_000 })
      const rotateResponse = page.waitForResponse(
        response =>
          response.request().method() === 'PUT' &&
          response.url().includes(encodeURIComponent(secretName)),
        { timeout: 30_000 }
      )
      await confirmDialog.getByRole('button', { name: 'Rotate & restart', exact: true }).click()
      const rotated = await rotateResponse
      expect(rotated.status()).toBe(200)
      cleanupIdentity = requireSecretIdentity(await rotated.json(), 'rotate cleanup identity')

      // The PUT landing shows "rotating", never a verdict by itself — the
      // verdict only comes from the CRD poll below.
      await expect(page.getByText(/Rotating credentials/)).toBeVisible({ timeout: 20_000 })

      // This rotates to a VALID credential, so the connector must come back
      // healthy: the only acceptable terminal state is SUCCESS. A timeout or
      // failure is diagnostic evidence, not a passing outcome.
      // Must exceed the UI's own POLL_TIMEOUT_MS (180s): the "did not finish
      // within" terminal message is only emitted at 180s, so a 150s assertion
      // timeout would expire in the dead window (150s–180s) and fail spuriously
      // on a slow-but-valid rollout. 185s clears it.
      await expect(page.getByText(/Credentials rotated\./)).toBeVisible({ timeout: 185_000 })
      await expect(page.getByText(/did not finish within/)).toHaveCount(0)
      await expect(page.getByText(/Rotation failed:/)).toHaveCount(0)

      await screenshotAndLog(page, testInfo, 'control-ui-connector-credential-rotation')
    } finally {
      const deleteConnector = await directApi(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      expect(deleteConnector.status, 'cleanup connector').toBe(200)
      if (!cleanupIdentity) throw new Error('missing cleanup identity')
      const deleteSecret = await directApi(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-secrets/${encodeURIComponent(secretName)}`,
        cleanupIdentity
      )
      expect(deleteSecret.status, 'cleanup connector credential').toBe(200)
      const deleteContext = await directApi(
        page.request,
        'DELETE',
        `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
      )
      expect(deleteContext.status, 'cleanup context').toBe(200)
    }
  })
})
