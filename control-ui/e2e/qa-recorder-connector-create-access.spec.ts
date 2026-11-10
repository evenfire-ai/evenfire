// control-ui/e2e/qa-recorder-connector-create-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Records creating a connector and then giving an agent access to it. The
// create wizard has no access step: a new connector is enabled in no Context
// and no agent reaches it. Access is granted afterwards from the connector
// row's "Add to agents" action on /connectors, which writes the seeded agent's
// Context allowlist. The finally deletes the connector, the
// seeded agent host, and its context (hosts before contexts).
//
// Contract: docs/testing/control-ui-headful-journeys.md.
import { type Page, type TestInfo, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  resourceName,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

type ContextListItem = {
  metadata?: { name?: string }
  name?: string
  spec?: { mcpServers?: string[] }
}

async function continueWizard(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
}

async function openCreateConnectorWizard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
  // Creation lives in the header's "Connector actions" menu, next to "Add remote server".
  await page.getByRole('button', { name: 'Connector actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Create connector', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })
}

// Identity placeholders → Secrets keyless radio. The wizard goes straight from
// the connector identity to its secrets.
async function createConnectorThroughWizard(
  page: Page,
  testInfo: TestInfo,
  journey: string,
  connectorName: string
): Promise<void> {
  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('qa-recorder/example:dev')
  await page
    .getByPlaceholder('Optional description of this connector')
    .fill('QA recorder connector created without agent access')
  await screenshotAndLog(page, testInfo, `${journey}-wizard-identity`)

  await continueWizard(page)

  await expect(page.getByRole('heading', { name: 'Agent access', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('radio', { name: /No credentials required/ }).check()
  await screenshotAndLog(page, testInfo, `${journey}-wizard-secrets`)

  await page.getByRole('button', { name: 'Create connector', exact: true }).click()
  await expect(
    page
      .getByText(
        'Connector created. Give agents access from the Installed Connectors list whenever you’re ready.',
        { exact: true }
      )
      .last()
  ).toBeVisible({
    timeout: 20_000,
  })
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
}

// The connector list has no expandable rows; its search also matches the agent labels
// bound to each connector, so filtering by the agent shows whether the row is bound.
async function searchConnectors(page: Page, query: string): Promise<void> {
  const search = page.getByLabel('Search connectors', { exact: true })
  await search.fill(query)
}

async function contextsListing(page: Page, connectorName: string): Promise<string[]> {
  const res = await api<{ items?: ContextListItem[] }>(
    page.request,
    'GET',
    '/api/v1/admin/contexts'
  )
  expect(res.status, `list contexts: ${JSON.stringify(res.data)}`).toBe(200)
  return (res.data.items ?? [])
    .filter(item => item.spec?.mcpServers?.includes(connectorName))
    .map(item => resourceName(item))
}

test.describe('optional QA recorder: Control UI connector create then Add to agents', () => {
  test('records creating a connector and then giving an agent access to it', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes local context, host, and connector resources.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-connector-create-access'
    const contextName = uniqueE2EName('qa-recorder-context')
    const agentName = uniqueE2EName('qa-recorder-agent')
    const connectorName = uniqueE2EName('qa-recorder-conn')

    try {
      await loginThroughUi(page, credentials)

      // Seed an agent (context + host) to give access to. The host display
      // name equals the resource name so the picker option and the Agents
      // group show the same label.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder connector access context',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

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

      await openCreateConnectorWizard(page)
      await createConnectorThroughWizard(page, testInfo, journey, connectorName)

      // Creating the connector enabled it in no Context, so no agent reaches it.
      expect(await contextsListing(page, connectorName)).toEqual([])
      await searchConnectors(page, agentName)
      await expect(page.getByRole('row', { name: new RegExp(connectorName) })).toHaveCount(0)
      await searchConnectors(page, connectorName)
      const row = page.getByRole('row', { name: new RegExp(connectorName) })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-without-agents`)

      await row.getByRole('button', { name: `Actions for connector ${connectorName}` }).click()
      await page.getByRole('menuitem', { name: 'Add to agents', exact: true }).click()
      const grantDialog = page.getByRole('dialog', {
        name: 'Give agents access to this connector',
      })
      await expect(grantDialog).toBeVisible({ timeout: 20_000 })
      await grantDialog.getByRole('checkbox', { name: new RegExp(agentName) }).check()
      await grantDialog.getByRole('button', { name: 'Add to agent', exact: true }).click()
      await expect(
        page.getByText(`Connector ${connectorName} added to agent ${agentName}.`)
      ).toBeVisible({ timeout: 20_000 })

      expect(await contextsListing(page, connectorName)).toEqual([contextName])
      await page.reload()
      await searchConnectors(page, agentName)
      await expect(page.getByRole('row', { name: new RegExp(connectorName) })).toBeVisible({
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, `${journey}-with-agent`)
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorName)}`
      )
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
