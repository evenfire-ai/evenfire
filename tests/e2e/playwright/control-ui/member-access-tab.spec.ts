/**
 * Control UI — Member detail Agents tab tests
 *
 * The member "Agents" tab (the former "Access" tab, originally "Contexts")
 * presents granted access as one table row per agent (D8): the
 * Agent/Connectors columns, the owning host's display name (spec.host) in
 * cell 1 — never the raw wire contextId — and the shared Connectors count
 * cell in cell 2. The add/remove flows are D8 composite writes (user-agents
 * AND user-contexts mappings), so cleanup restores both the original
 * contextIds and the original agentNames.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const CONTEXT_NAME = `e2e-member-access-ctx-${RUN}`
const CONTEXT_ID = `e2e-member-access-scope-${RUN}`
const HOST_NAME = `e2e-member-access-host-${RUN}`
const HOST_DISPLAY_NAME = `e2e-member-access-agent-${RUN}`

let userId = ''
let originalContextIds: string[] = []
let originalAgentNames: string[] = []

test.describe('Control UI — Member Agents tab', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const { items } = await controlApi.getUsers('')
    if (items.length === 0) {
      test.skip(true, 'no users seeded — run: make minikube-seed-test-data')
      return
    }
    userId = items[0].id
    originalContextIds = (await controlApi.getUserContexts(userId)).contextIds ?? []
    originalAgentNames = (await controlApi.getUserAgents(userId)).agentNames ?? []

    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_ID, description: 'E2E member access scope' },
    })
    await controlApi.createHost({
      metadata: { name: HOST_NAME },
      spec: {
        host: HOST_DISPLAY_NAME,
        contextRef: CONTEXT_ID,
        secretRef: '',
        channels: [],
      },
    })
    await controlApi.updateUserContexts(userId, [...originalContextIds, CONTEXT_ID])
  })

  test.afterAll(async () => {
    if (userId) {
      try {
        await controlApi.updateUserContexts(userId, originalContextIds)
        // D8 composite write: the tab's remove also rewrote the member↔agent
        // mapping, so restore the original agentNames too (PUT is
        // compare-and-swap: echo the full set we currently observe).
        const current = await controlApi.getUserAgents(userId)
        await controlApi.putUserAgents(userId, originalAgentNames, [
          ...(current.agentNames ?? []),
          ...(current.deletedAgentNames ?? []),
        ])
      } catch {
        // best effort restore — cluster may already be unreachable
      }
    }
    await controlApi.ensureHostDeleted(HOST_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('shows the agent display name, not the raw scope id', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/agents`)
    await expect(
      authedPage.getByText('Agents this member may use — and the connectors each one carries.')
    ).toBeVisible({ timeout: 15_000 })

    // D8: granted access renders as a real table — Agent/Connectors columns,
    // one row per granted agent, labelled by its display name.
    await expect(authedPage.getByRole('columnheader', { name: 'Agent', exact: true })).toBeVisible()
    await expect(
      authedPage.getByRole('columnheader', { name: 'Connectors', exact: true })
    ).toBeVisible()
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row).not.toContainText(CONTEXT_ID)
  })

  test("'Add agents' opens the agent picker modal", async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/agents`)
    await expect(
      authedPage.getByText('Agents this member may use — and the connectors each one carries.')
    ).toBeVisible({ timeout: 15_000 })

    await authedPage.getByRole('button', { name: 'Add agents', exact: true }).click()

    const dialog = authedPage.getByRole('dialog', { name: 'Add agents' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Agents')).toBeVisible()
    await expect(dialog.locator('#member-agent-picker')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add agents', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('removing an agent confirms, toasts, and clears the mapping via the API', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/users/${encodeURIComponent(userId)}/agents`)
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15_000 })

    await row.getByLabel('Remove agent').click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Remove Agent' })
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog).toContainText(
      'This revokes the agent and every connector it carries.'
    )
    await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click()

    await expect(authedPage.getByRole('status').filter({ hasText: 'Agents updated.' })).toBeVisible(
      { timeout: 15_000 }
    )
    await expect(row).toHaveCount(0)
    if (originalContextIds.length === 0 && originalAgentNames.length === 0) {
      await expect(authedPage.getByText('No agents assigned yet.')).toBeVisible()
    }

    const { contextIds } = await controlApi.getUserContexts(userId)
    expect(contextIds ?? []).not.toContain(CONTEXT_ID)
    const { agentNames } = await controlApi.getUserAgents(userId)
    expect(agentNames ?? []).not.toContain(HOST_NAME)
  })
})
