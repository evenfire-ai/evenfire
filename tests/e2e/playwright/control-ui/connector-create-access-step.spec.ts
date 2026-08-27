/**
 * Control UI — Connector create wizard Access step
 *
 * /connectors/new walks Connector → Access → Secrets. The Access step offers
 * an optional agent multi-select: selecting an agent binds the new connector
 * to that agent's scope; selecting none leaves it unreachable ("No agents
 * have access yet.") until access is granted from the list.
 */
import type { Page } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

const stamp = Date.now()
const agentName = `e2e-ccas-agent-${stamp}`
const contextName = `e2e-ccas-ctx-${stamp}`
const seedServerName = `e2e-ccas-srv-${stamp}`
const connectorWithAgent = `e2e-ccas-conn-a-${stamp}`
const connectorWithoutAgent = `e2e-ccas-conn-b-${stamp}`

async function dismissAdminEmailPromptIfPresent(page: Page): Promise<void> {
  // AdminBridgeAlerts shows "Set up your admin email" for admin accounts
  // without a recovery email and overlays the page. Dismissing it is a named
  // test precondition (this suite does not test that prompt); the click is
  // logged so a run transcript shows exactly what happened.
  const remindLater = page.getByRole('button', { name: 'Remind me later' })
  try {
    await remindLater.waitFor({ state: 'visible', timeout: 3_000 })
  } catch {
    return // prompt not shown — nothing to dismiss
  }
  console.log('[e2e] dismissing "Set up your admin email" prompt (Remind me later)')
  await remindLater.click()
  await remindLater.waitFor({ state: 'hidden', timeout: 5_000 })
}

/**
 * Walks the wizard end-to-end. `agentToSelect` picks the seeded agent on the
 * Access step; omit it to create the connector with no agent access. The
 * agent picker's Field label is not programmatically associated with the
 * dropdown trigger, so the trigger is matched by its placeholder name (the
 * same contract the component tests rely on).
 */
async function createConnectorThroughWizard(
  page: Page,
  connectorName: string,
  agentToSelect?: string
): Promise<void> {
  await page.goto('/connectors/new')
  await expect(page.getByPlaceholder('my-mcp-server')).toBeVisible({ timeout: 15_000 })
  await dismissAdminEmailPromptIfPresent(page)

  // Step 0 — Connector identity.
  await page.getByPlaceholder('my-mcp-server').fill(connectorName)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('clerum/mock-mcp-server:test')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step 1 — Access (optional agents).
  await expect(page.getByRole('heading', { name: 'Agent access' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(
    page.getByText(
      'No agents selected: the connector is created but cannot be used by any agent until you grant access.'
    )
  ).toBeVisible()
  if (agentToSelect) {
    await page.getByRole('button', { name: 'Select agents...' }).click()
    await page.getByRole('option', { name: agentToSelect, exact: true }).click()
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step 2 — Secrets and environment.
  await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible({
    timeout: 10_000,
  })
  await page.getByRole('radio', { name: /No credentials required/ }).check()
  await page.getByRole('button', { name: 'Create connector', exact: true }).click()

  await expect(page.getByText('Connector created successfully.')).toBeVisible({ timeout: 30_000 })
  await page.waitForURL(/\/connectors\/?$/, { timeout: 15_000 })
}

async function expandConnector(page: Page, connectorName: string) {
  const row = page.getByRole('row', { name: new RegExp(connectorName) })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 10_000 })
  const detail = page.locator('.cu-connector-detail')
  await expect(detail).toBeVisible({ timeout: 10_000 })
  return detail
}

/**
 * A no-agent connector gets a generated private scope (`<name>-<5 digits>`).
 * The wizard never surfaces it, so teardown finds it by that pattern.
 */
async function deletePrivateScopesFor(prefix: string): Promise<void> {
  try {
    const { items } = await controlApi.getContexts()
    const names = items
      .map(item => String((item as { metadata?: { name?: string } }).metadata?.name ?? ''))
      .filter(name => new RegExp(`^${prefix}-\\d{5}$`).test(name))
    for (const name of names) await controlApi.ensureContextDeleted(name)
  } catch {
    // best effort — teardown must not mask test failures
  }
}

test.describe('Control UI — Connector create Access step', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    // PRECONDITION (labeled setup): a seeded agent bound to a context that
    // already carries one connector, so the wizard's agent picker and the
    // connectors list have live entries to work with.
    await controlApi.createMcpServer({
      metadata: { name: seedServerName },
      spec: {
        image: 'clerum/mock-mcp-server:test',
        contextRef: contextName,
        enabled: true,
        managed: true,
        transport: {
          type: 'streamableHttp',
          port: 3000,
          url: `http://${seedServerName}.mcp-server.svc.cluster.local:3000/mcp`,
        },
      },
    })
    await controlApi.createContext({
      metadata: { name: contextName },
      spec: {
        contextId: contextName,
        description: `Connector create fixture for ${agentName}`,
        mcpServers: [seedServerName],
      },
    })
    await controlApi.createHost({
      metadata: { name: agentName },
      spec: {
        host: agentName,
        contextRef: contextName,
        secretRef: '',
        channels: [],
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
      },
    })
  })

  test.afterAll(async () => {
    await controlApi.ensureMcpServerDeleted(connectorWithAgent)
    await controlApi.ensureMcpServerDeleted(connectorWithoutAgent)
    await controlApi.ensureMcpServerDeleted(seedServerName)
    await controlApi.ensureHostDeleted(agentName)
    await deletePrivateScopesFor(connectorWithoutAgent)
    await controlApi.ensureContextDeleted(contextName)
  })

  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('a connector created with an agent selected appears bound to that agent', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    await createConnectorThroughWizard(authedPage, connectorWithAgent, agentName)

    const detail = await expandConnector(authedPage, connectorWithAgent)
    await expect(detail.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible()
    await expect(detail.getByText(agentName, { exact: true })).toBeVisible()
  })

  test('a connector created with no agents selected is not usable by any agent yet', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    await createConnectorThroughWizard(authedPage, connectorWithoutAgent)

    const detail = await expandConnector(authedPage, connectorWithoutAgent)
    await expect(detail.getByText('No agents have access yet.')).toBeVisible()
  })
})
