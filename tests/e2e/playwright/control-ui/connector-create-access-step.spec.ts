/**
 * Control UI — Connector create, then "Add to agents"
 *
 * /connectors/new walks Connector → Secrets: the wizard has no access step. A
 * new connector is enabled in no Context, so no agent reaches it, and no
 * Context is created for it. Access is granted afterwards from the connector
 * row's "Add to agents" action, which writes the agent's Context allowlist.
 */
import type { Page } from '@playwright/test'
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'
import { CUI_DASHBOARD } from '../helpers/selectors'

const stamp = Date.now()
const agentName = `e2e-ccas-agent-${stamp}`
const contextName = `e2e-ccas-ctx-${stamp}`
const connectorName = `e2e-ccas-conn-${stamp}`

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

async function createConnectorThroughWizard(page: Page, name: string): Promise<void> {
  await page.goto('/connectors/new')
  await expect(page.getByPlaceholder('my-mcp-server')).toBeVisible({ timeout: 15_000 })
  await dismissAdminEmailPromptIfPresent(page)

  // Step 0 — Connector identity.
  await page.getByPlaceholder('my-mcp-server').fill(name)
  await page
    .getByPlaceholder('us-central1-docker.pkg.dev/my-project/repo/mcp-server:latest')
    .fill('clerum/mock-mcp-server:test')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()

  // Step 1 — Secrets and environment; there is no access step in between.
  await expect(page.getByRole('heading', { name: 'Secrets and environment' })).toBeVisible({
    timeout: 10_000,
  })
  await expect(page.getByRole('heading', { name: 'Agent access' })).toHaveCount(0)
  await page.getByRole('radio', { name: /No credentials required/ }).check()
  await page.getByRole('button', { name: 'Create connector', exact: true }).click()

  await expect(
    page.getByText(
      'Connector created. Give agents access from the Installed Connectors list whenever you’re ready.'
    )
  ).toBeVisible({ timeout: 30_000 })
  await page.waitForURL(/\/connectors\/?$/, { timeout: 15_000 })
}

async function contextsEnabling(serverName: string): Promise<string[]> {
  const { items } = await controlApi.getContexts()
  return (items as Array<{ metadata?: { name?: string }; spec?: { mcpServers?: string[] } }>)
    .filter(item => item.spec?.mcpServers?.includes(serverName))
    .map(item => String(item.metadata?.name ?? ''))
}

// The connector list has no expandable rows; its search also matches the agent labels
// bound to each connector, so filtering by the agent shows whether the row is bound.
function connectorRow(page: Page, name: string) {
  return page.getByRole('row', { name: new RegExp(name) })
}

test.describe('Control UI — Connector create, then Add to agents', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    // PRECONDITION (labeled setup): a seeded agent bound to an empty context,
    // so the "Add to agents" dialog has a live target.
    await controlApi.createContext({
      metadata: { name: contextName },
      spec: {
        contextId: contextName,
        description: `Connector create fixture for ${agentName}`,
        mcpServers: [],
      },
    })
    await controlApi.createHost({
      metadata: { name: agentName },
      spec: {
        host: agentName,
        contextRef: contextName,
        secretRef: '',
        channels: [],
      },
    })
  })

  test.afterAll(async () => {
    await controlApi.ensureMcpServerDeleted(connectorName)
    await controlApi.ensureHostDeleted(agentName)
    await controlApi.ensureContextDeleted(contextName)
  })

  test.beforeEach(async ({ authedPage }) => {
    await expect(authedPage.locator(CUI_DASHBOARD.HEADING)).toBeVisible()
  })

  test('a created connector reaches an agent only after "Add to agents"', async ({
    authedPage,
  }) => {
    test.setTimeout(180_000)
    await createConnectorThroughWizard(authedPage, connectorName)

    expect(await contextsEnabling(connectorName)).toEqual([])
    const search = authedPage.getByLabel('Search connectors', { exact: true })
    await search.fill(agentName)
    await expect(connectorRow(authedPage, connectorName)).toHaveCount(0)

    await search.fill(connectorName)
    const row = connectorRow(authedPage, connectorName)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.getByRole('button', { name: `Actions for connector ${connectorName}` }).click()
    await authedPage.getByRole('menuitem', { name: 'Add to agents', exact: true }).click()
    const dialog = authedPage.getByRole('dialog', {
      name: 'Give agents access to this connector',
    })
    await expect(dialog).toBeVisible({ timeout: 20_000 })
    await dialog.getByRole('checkbox', { name: new RegExp(agentName) }).check()
    await dialog.getByRole('button', { name: 'Add to agent', exact: true }).click()
    await expect(
      authedPage.getByText(`Connector ${connectorName} added to agent ${agentName}.`)
    ).toBeVisible({ timeout: 20_000 })

    expect(await contextsEnabling(connectorName)).toEqual([contextName])
    await authedPage.reload()
    await authedPage.getByLabel('Search connectors', { exact: true }).fill(agentName)
    await expect(connectorRow(authedPage, connectorName)).toBeVisible({ timeout: 20_000 })
  })
})
