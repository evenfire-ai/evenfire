/**
 * Control UI — Team detail Agents tab tests
 *
 * The team "Agents" tab (the former "Access" tab, originally "Contexts")
 * presents granted access as one table row per agent (D8): the
 * Agent/Connectors columns, the agent display name in cell 1 (never the raw
 * scope id), the shared Connectors count cell in cell 2. The add/remove
 * flows round-trip the D8 composite write (team-agents AND team-contexts
 * mappings), and the legacy /contexts and /access deep links redirect to
 * /agents.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const TEAM_NAME = `e2e-team-access-team-${RUN}`
const CONTEXT_NAME = `e2e-team-access-ctx-${RUN}`
const CONTEXT_ID = `e2e-team-access-scope-${RUN}`
const HOST_NAME = `e2e-team-access-host-${RUN}`
const HOST_DISPLAY_NAME = `e2e-team-access-agent-${RUN}`

let teamId = ''

test.describe('Control UI — Team Agents tab', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const team = await controlApi.createTeam(TEAM_NAME)
    teamId = team.id

    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_ID, description: 'E2E team access scope' },
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
    await controlApi.updateTeamContexts(teamId, [CONTEXT_ID])
  })

  test.afterAll(async () => {
    if (teamId) await controlApi.ensureTeamDeleted(teamId)
    await controlApi.ensureHostDeleted(HOST_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('shows the agent display name, not the raw scope id', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/agents`)
    await expect(authedPage.getByText('Members, connector access, and agents.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      authedPage.getByText('Agents this team may use — and the connectors each one carries.')
    ).toBeVisible()

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
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/agents`)
    await expect(
      authedPage.getByText('Agents this team may use — and the connectors each one carries.')
    ).toBeVisible({ timeout: 15_000 })

    await authedPage.getByRole('button', { name: 'Add agents', exact: true }).click()

    const dialog = authedPage.getByRole('dialog', { name: 'Add agents' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Agents')).toBeVisible()
    await expect(dialog.locator('#team-agent-picker')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add agents', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('removing an agent confirms, toasts, and clears the mapping via the API', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/agents`)
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

    await expect(
      authedPage.getByRole('status').filter({ hasText: 'Team agents updated.' })
    ).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveCount(0)
    await expect(authedPage.getByText('No agents assigned yet.')).toBeVisible()

    const { contextIds } = await controlApi.getTeamContexts(teamId)
    expect(contextIds ?? []).not.toContain(CONTEXT_ID)
    const { agentNames } = await controlApi.getTeamAgents(teamId)
    expect(agentNames ?? []).not.toContain(HOST_NAME)
  })

  test('legacy /contexts deep link redirects to /agents', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/contexts`)
    await authedPage.waitForURL('**/users-and-teams/teams/*/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain(`/teams/${teamId}/agents`)
  })

  test('legacy /access deep link redirects to /agents (D10 renamed the Access tab)', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    await authedPage.waitForURL('**/users-and-teams/teams/*/agents', { timeout: 15_000 })
    expect(authedPage.url()).toContain(`/teams/${teamId}/agents`)
  })
})
