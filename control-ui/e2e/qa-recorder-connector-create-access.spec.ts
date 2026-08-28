// control-ui/e2e/qa-recorder-connector-create-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Records the create-connector wizard's Access step twice: once with a seeded
// agent selected (agent picker + "Access preview" + the post-create Agents
// group binding on /connectors) and once with no agents ("No agents have
// access yet."). A no-agent connector silently provisions a private scope
// (<name>-#####); that scope is discovered through GET /api/v1/admin/contexts
// and deleted in the finally along with both connectors, the seeded agent
// host, and its context (hosts before contexts).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder").
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

type ContextListItem = { metadata?: { name?: string }; name?: string }

async function continueWizard(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
}

async function openCreateConnectorWizard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Installed Connectors', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
  // Creation lives behind the "Connector actions" kebab (lowercase c menuitem).
  await page.getByRole('button', { name: 'Connector actions' }).click()
  await page.getByRole('menuitem', { name: 'Create connector', exact: true }).click()
  await expect(page).toHaveURL(/\/connectors\/new$/, { timeout: 20_000 })
}

// Mirrors the proven port (tests/e2e/playwright/control-ui/
// connector-create-access-step.spec.ts): identity placeholders → optional
// Access step → Secrets keyless radio. With agentToSelect the agent picker is
// opened (the trigger is matched by its placeholder, not a label) and that
// agent chosen; without it the Access step is skipped, which is exactly the
// branch that silently provisions a private scope.
async function createConnectorThroughWizard(
  page: Page,
  testInfo: TestInfo,
  journey: string,
  connectorName: string,
  agentToSelect?: string
): Promise<void> {
  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('qa-recorder/example:dev')
  await page
    .getByPlaceholder('Optional description of this connector')
    .fill(`QA recorder access-step connector (${agentToSelect ? 'with agent' : 'no agents'})`)
  await screenshotAndLog(page, testInfo, `${journey}-wizard-identity`)

  await continueWizard(page)

  await expect(page.getByRole('heading', { name: 'Agent access', exact: true })).toBeVisible({
    timeout: 20_000,
  })
  if (agentToSelect) {
    await page.getByRole('button', { name: 'Select agents...' }).click()
    await page.getByRole('option', { name: agentToSelect, exact: true }).click()
    await expect(page.getByText('Access preview', { exact: true })).toBeVisible()
    await expect(
      page
        .getByRole('region', { name: 'Agent access preview' })
        .getByText(agentToSelect, { exact: true })
    ).toBeVisible()
    await screenshotAndLog(page, testInfo, `${journey}-wizard-access-preview`)
  } else {
    await expect(
      page.getByText(
        'No agents selected: the connector is created but cannot be used by any agent until you grant access.',
        { exact: true }
      )
    ).toBeVisible()
    await screenshotAndLog(page, testInfo, `${journey}-wizard-access-empty`)
  }
  await continueWizard(page)

  await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible({
    timeout: 20_000,
  })
  await page.getByRole('radio', { name: /No credentials required/ }).check()
  await screenshotAndLog(page, testInfo, `${journey}-wizard-secrets`)

  await page.getByRole('button', { name: 'Create connector', exact: true }).click()
  await expect(page.getByText('Connector created successfully.', { exact: true })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page).toHaveURL(/\/connectors$/, { timeout: 20_000 })
}

async function expandConnector(page: Page, connectorName: string) {
  const row = page.getByRole('button', { name: new RegExp(`Expand connector ${connectorName}`) })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(
    page.getByRole('button', { name: new RegExp(`Collapse connector ${connectorName}`) })
  ).toBeVisible({ timeout: 10_000 })
  const detail = page.locator('.cu-connector-detail')
  await expect(detail).toBeVisible({ timeout: 10_000 })
  return detail
}

test.describe('optional QA recorder: Control UI connector create Access step', () => {
  test('records creating a connector with an agent and one without any', async ({
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
    const connectorWithAgent = uniqueE2EName('qa-recorder-conn-a')
    const connectorWithoutAgent = uniqueE2EName('qa-recorder-conn-b')
    let privateScopeName = ''

    try {
      await loginThroughUi(page, credentials)

      // Seed an agent (context + host) so the wizard's agent picker has a
      // target. The host display name equals the resource name so the picker
      // option, preview, and Agents group all show the same label.
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

      // Connector #1 — WITH an agent selected on the Access step.
      await openCreateConnectorWizard(page)
      await createConnectorThroughWizard(page, testInfo, journey, connectorWithAgent, agentName)

      const withAgentDetail = await expandConnector(page, connectorWithAgent)
      await expect(
        withAgentDetail.getByRole('heading', { name: 'Agents', exact: true })
      ).toBeVisible()
      await expect(withAgentDetail.getByText(agentName, { exact: true })).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-with-agent`)

      // Connector #2 — Access step skipped (no agents).
      await openCreateConnectorWizard(page)
      await createConnectorThroughWizard(page, testInfo, journey, connectorWithoutAgent)

      const withoutAgentDetail = await expandConnector(page, connectorWithoutAgent)
      await expect(
        withoutAgentDetail.getByText('No agents have access yet.', { exact: true })
      ).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-without-agents`)

      // The wizard never surfaces the private scope; discover it through the
      // Control API so the finally can tear it down too.
      const scopesRes = await api<{ items?: ContextListItem[] }>(
        page.request,
        'GET',
        '/api/v1/admin/contexts'
      )
      expect(scopesRes.status, `list contexts: ${JSON.stringify(scopesRes.data)}`).toBe(200)
      privateScopeName =
        (scopesRes.data.items ?? [])
          .map(item => resourceName(item))
          .find(name => new RegExp(`^${connectorWithoutAgent}-[0-9]{5}$`).test(name)) ?? ''
      expect(privateScopeName, 'private scope context for the no-agent connector').toBeTruthy()
    } finally {
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorWithoutAgent)}`
      )
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/mcp-servers/${encodeURIComponent(connectorWithAgent)}`
      )
      if (privateScopeName) {
        await api(
          page.request,
          'DELETE',
          `/api/v1/admin/contexts/${encodeURIComponent(privateScopeName)}`
        )
      }
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(agentName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
