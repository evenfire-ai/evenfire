/**
 * Control UI — Team detail Access tab tests
 *
 * The team "Access" tab (the former "Contexts" tab) must present host-backed
 * access scopes by their agent display name, the add/remove flows must
 * round-trip the admin team-context API, and the legacy /contexts deep link
 * must redirect to /access.
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

test.describe('Control UI — Team Access tab', () => {
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
        model: { provider: 'openai', name: 'gpt-5.4-mini' },
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
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    await expect(authedPage.getByText('Members, connector access, and agents.')).toBeVisible({
      timeout: 15_000,
    })
    await expect(
      authedPage.getByText('Agents and connector scopes this team may access.')
    ).toBeVisible()

    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toHaveCount(1)
    await expect(row).not.toContainText(CONTEXT_ID)
  })

  test("'Add access' opens the access picker modal", async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    await expect(
      authedPage.getByText('Agents and connector scopes this team may access.')
    ).toBeVisible({ timeout: 15_000 })

    await authedPage.getByRole('button', { name: 'Add access', exact: true }).click()

    const dialog = authedPage.getByRole('dialog', { name: 'Add access' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Access')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add access', exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
  })

  test('removing access confirms, toasts, and clears the mapping via the API', async ({
    authedPage,
  }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15_000 })

    await row.getByLabel('Remove access').click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Remove Access' })
    await expect(confirmDialog).toBeVisible()
    await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()

    await expect(
      authedPage.getByRole('status').filter({ hasText: 'Team access updated.' })
    ).toBeVisible({ timeout: 15_000 })
    await expect(row).toHaveCount(0)
    await expect(authedPage.getByText('No access assigned yet.')).toBeVisible()

    const { contextIds } = await controlApi.getTeamContexts(teamId)
    expect(contextIds ?? []).not.toContain(CONTEXT_ID)
  })

  test('legacy /contexts deep link redirects to /access', async ({ authedPage }) => {
    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/contexts`)
    await authedPage.waitForURL('**/users-and-teams/teams/*/access', { timeout: 15_000 })
    expect(authedPage.url()).toContain(`/teams/${teamId}/access`)
  })
})
