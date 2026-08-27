// control-ui/e2e/qa-recorder-connector-edit.spec.ts
//
// MUTATING journey: stages a context through the Control API, creates a stdio
// discovery connector through the create-connector wizard (which also
// provisions the connector's own private access scope), then edits the
// connector to add external CIDR egress. Guarded by
// QA_RECORDER_CONFIRM_MUTATIONS; the connector and both contexts are deleted
// via the Control API in a finally.
import { type Page, expect, test } from '@playwright/test'
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

// The rotation journey stages its connector on the mock MCP image (mirroring the
// T2 integration `localMcpServerYaml` fixture) so the HCC rolls out a REAL
// Deployment the UI can poll to a genuine `DeploymentReady=True` — an unmanaged
// or non-existent image would never converge, only time out.
const MOCK_MCP_IMAGE = process.env.TEST_MOCK_MCP_IMAGE ?? 'clerum/mock-mcp-server:test'

// The connector-form selects are not label-associated (no htmlFor/id), so scope
// to the wrapping `.cu-field` by its visible label text and drive its <select>.
async function fieldSelect(page: Page, fieldLabelText: string, value: string): Promise<void> {
  const field = page.locator('.cu-field', { hasText: fieldLabelText }).first()
  await field.locator('select').selectOption(value)
}

// The /contexts UI is gone; stage the context out-of-band through the Control
// API (same pattern as the rotation test below).
async function createEmptyContext(page: Page, contextName: string): Promise<void> {
  const res = await api(page.request, 'POST', '/api/v1/admin/contexts', {
    metadata: { name: contextName },
    spec: {
      contextId: contextName,
      description: 'QA recorder temporary context',
      mcpServers: [],
    },
  })
  expect(res.status, `create context: ${JSON.stringify(res.data)}`).toBeLessThan(300)
}

async function createDiscoveryConnector(page: Page, connectorName: string): Promise<void> {
  await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
  await page.getByRole('button', { name: 'Create Connector', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })

  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('qa-recorder/example:dev')
  await page
    .getByPlaceholder('Optional description of this connector')
    .fill('QA recorder discovery-only connector')

  // Runtime settings now live behind the collapsible Advanced options on the
  // Connector step.
  await page.getByText('Advanced options', { exact: true }).click()
  await fieldSelect(page, 'Transport Type', 'stdio')
  await expect(page.locator('input[type="number"]')).toHaveCount(0)
  await fieldSelect(page, 'Managed', 'false')

  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Access step: the agents multi-select is optional — skip it.
  await expect(page.getByRole('heading', { name: 'Agent access', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Secrets step: explicitly pick the keyless credential mode — the wizard
  // keeps Create connector disabled until a credential choice is made.
  await page.getByText('No credentials required', { exact: true }).click()

  await page.getByRole('button', { name: 'Create connector', exact: true }).click()
  await expect(page.getByText('Connector created successfully.', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
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
    let connectorContextName = ''

    try {
      await loginThroughUi(page, credentials)

      await createEmptyContext(page, contextName)
      await createDiscoveryConnector(page, connectorName)

      // The wizard provisions the connector's private access scope out of
      // band; capture its name so the finally can tear it down too.
      const createdRes = await api(
        page.request,
        'GET',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      expect(createdRes.status, `read connector: ${JSON.stringify(createdRes.data)}`).toBe(200)
      connectorContextName = String(
        (createdRes.data.spec as { contextRef?: string } | undefined)?.contextRef || ''
      )
      expect(connectorContextName).toMatch(new RegExp(`^${connectorName}-[0-9]{5}$`))

      await page.goto(`${CONTROL_UI_URL}/connectors/${encodeURIComponent(connectorName)}/edit`)
      await expect(
        page.getByRole('heading', { name: `Edit Connector: ${connectorName}`, exact: true })
      ).toBeVisible({ timeout: 20_000 })

      // Access is a read-only final tab. It mirrors the agents, teams, and
      // users that can already reach this connector without offering a
      // mutation.
      await page.getByRole('tab', { name: 'Access', exact: true }).click()
      await expect(page).toHaveURL(
        new RegExp(`/connectors/${encodeURIComponent(connectorName)}/edit/access$`)
      )
      await expect(page.getByRole('heading', { name: 'Agent access', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByLabel('Agent access')).toBeVisible()

      await page.getByRole('tab', { name: 'External Egress', exact: true }).click()

      // Image and access scopes are rendered as static read-only text (not
      // editable inputs).
      const meta = page.locator('.cu-connector-edit-meta')
      await expect(meta).toBeVisible({ timeout: 20_000 })
      await expect(meta.getByText('qa-recorder/example:dev')).toBeVisible()
      await expect(meta.getByText(connectorContextName)).toBeVisible()

      // External Egress: switch to exact-CIDR mode and add one public CIDR + port.
      // 8.8.8.8/32 is a valid public target; the model rejects private/doc ranges.
      await fieldSelect(page, 'Egress mode', 'exact-cidr')
      await page
        .locator('.cu-field', { hasText: 'Allowed CIDRs/IPs' })
        .first()
        .locator('textarea')
        .fill('8.8.8.8/32')
      await page
        .locator('.cu-field', { hasText: 'Allowed ports' })
        .first()
        .locator('input')
        .fill('443')

      await page.getByRole('button', { name: 'Save egress', exact: true }).click()
      await expect(
        page.getByText(`Connector ${connectorName} updated.`, { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-connector-edit')
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      if (connectorContextName) {
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/contexts/${encodeURIComponent(connectorContextName)}`
        )
      }
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })

  // Issue #223: rotates a connector's credential through the "Update
  // credentials" section and rides the polling out to a terminal state.
  // Precondition-only navigation (page.goto to the edit screen) is fine, but
  // the rotation itself — filling the new value, confirming the restart
  // warning, saving, watching the status settle — is driven exclusively by
  // real user actions against the live control-api/HCC, never a direct PUT,
  // never a mocked backend, never `waitForTimeout`.
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

      await page.goto(`${CONTROL_UI_URL}/connectors/${encodeURIComponent(connectorName)}/edit`)
      await expect(
        page.getByRole('heading', { name: `Edit Connector: ${connectorName}`, exact: true })
      ).toBeVisible({ timeout: 20_000 })

      // The connector edit screen is split into tabs; the rotation flow lives
      // on the Credentials tab — navigate there via the tab link.
      await page.getByRole('tab', { name: 'Credentials', exact: true }).click()
      await expect(page).toHaveURL(
        new RegExp(`/connectors/${encodeURIComponent(connectorName)}/edit/credentials$`),
        { timeout: 20_000 }
      )

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
      await confirmDialog.getByRole('button', { name: 'Rotate & restart', exact: true }).click()

      // The PUT landing shows "rotating", never a verdict by itself — the
      // verdict only comes from the CRD poll below.
      await expect(page.getByText(/Rotating credentials/)).toBeVisible({ timeout: 20_000 })

      // This rotates to a VALID credential, so the connector must come back
      // healthy: the terminal state is SUCCESS. A bounded "did not finish
      // within" is tolerated as cluster slowness. But "Rotation failed:" is NOT
      // an acceptable outcome here — it would mean the UI reported the normal
      // transitory DeploymentReady=False/WaitingForReplicas as a failure (the
      // B1 defect). Accepting it (as this spec used to) let the bug pass in
      // green; asserting its absence makes the test catch a regression.
      // Must exceed the UI's own POLL_TIMEOUT_MS (180s): the "did not finish
      // within" terminal message is only emitted at 180s, so a 150s assertion
      // timeout would expire in the dead window (150s–180s) and fail spuriously
      // on a slow-but-valid rollout. 185s clears it.
      await expect(
        page.getByText(/Credentials rotated\./).or(page.getByText(/did not finish within/))
      ).toBeVisible({ timeout: 185_000 })
      await expect(page.getByText(/Rotation failed:/)).toHaveCount(0)

      await screenshotAndLog(page, testInfo, 'control-ui-connector-credential-rotation')
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-secrets/${encodeURIComponent(secretName)}`
      )
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
