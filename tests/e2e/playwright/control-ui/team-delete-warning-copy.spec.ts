/**
 * Control UI — Team delete warning copy
 *
 * Deleting a team removes its access scopes. The confirm dialog on
 * /users-and-teams/teams must warn about "team access/agent mappings" and
 * must not use the removed "context" vocabulary. The journey cancels out —
 * the team is never deleted by this test.
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const TEAM_NAME = `e2e-team-del-team-${RUN}`

let teamId = ''

test.describe('Control UI — Team delete warning copy', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    const team = await controlApi.createTeam(TEAM_NAME)
    teamId = team.id
  })

  test.afterAll(async () => {
    if (teamId) await controlApi.ensureTeamDeleted(teamId)
  })

  test('delete confirm warns about team access/agent mappings without "context", cancel keeps the team', async ({
    authedPage,
  }) => {
    await authedPage.goto('/users-and-teams/teams')

    const deleteButton = authedPage.getByLabel(`Delete team ${TEAM_NAME}`)
    await expect(deleteButton).toBeVisible({ timeout: 15_000 })
    await deleteButton.click()

    const confirmDialog = authedPage.getByRole('alertdialog', { name: 'Delete team?' })
    await expect(confirmDialog).toBeVisible()

    const dialogText = await confirmDialog.innerText()
    expect(dialogText).toContain('team access/agent mappings')
    expect(dialogText.toLowerCase()).not.toContain('context')

    // Cancel out — the team must survive.
    await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmDialog).toHaveCount(0)

    const { items } = await controlApi.getTeams()
    expect(items.some(team => team.id === teamId)).toBe(true)
  })
})
