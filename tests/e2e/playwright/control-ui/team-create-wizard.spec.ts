/**
 * Control UI — Team create wizard Access step tests
 *
 * The wizard rail is Team → Members → Access (D8 dropped the fourth step);
 * the Access step offers agent display names (not raw scope ids) and a
 * selection made there lands on the created team as BOTH the team-contexts
 * and team-agents mappings (D8 composite write).
 */
import { controlApi } from '../helpers/api-client'
import { expect, test } from '../helpers/auth-fixture'

const RUN = Date.now()
const TEAM_NAME = `e2e-wizard-team-${RUN}`
const CONTEXT_NAME = `e2e-wizard-ctx-${RUN}`
const CONTEXT_ID = `e2e-wizard-scope-${RUN}`
const HOST_NAME = `e2e-wizard-host-${RUN}`
const HOST_DISPLAY_NAME = `e2e-wizard-agent-${RUN}`

async function waitForTeamIdByName(name: string): Promise<string> {
  const deadline = Date.now() + 30_000
  for (;;) {
    const { items } = await controlApi.getTeams()
    const match = items.find(team => team.name === name)
    if (match) return match.id
    if (Date.now() > deadline) return ''
    await new Promise(resolve => setTimeout(resolve, 1_000))
  }
}

test.describe('Control UI — Team create wizard', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    await controlApi.createContext({
      metadata: { name: CONTEXT_NAME },
      spec: { contextId: CONTEXT_ID, description: 'E2E team wizard access scope' },
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
  })

  test.afterAll(async () => {
    if (TEAM_NAME) {
      try {
        const teamId = await waitForTeamIdByName(TEAM_NAME)
        if (teamId) await controlApi.ensureTeamDeleted(teamId)
      } catch {
        // best effort — team creation may have failed or cluster is unreachable
      }
    }
    await controlApi.ensureHostDeleted(HOST_NAME)
    await controlApi.ensureContextDeleted(CONTEXT_NAME)
  })

  test('Access step grants by agent display name and lands the mapping on the team', async ({
    authedPage,
  }) => {
    test.setTimeout(120_000)
    await authedPage.goto('/users-and-teams/teams/new')

    // D8 rail: three steps, no fourth.
    await expect(authedPage.locator('.cu-agent-step-rail__title')).toHaveText([
      'Team',
      'Members',
      'Access',
    ])

    // Step 0 — Team identity
    await authedPage.getByLabel('Team name').fill(TEAM_NAME)
    await authedPage.getByRole('button', { name: 'Continue', exact: true }).click()

    // Step 1 — Members: skip for now
    await authedPage.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(
      authedPage.getByText('Choose the agents this team can use — their connectors come along.')
    ).toBeVisible({ timeout: 15_000 })

    // Step 2 (last) — Access: options are agent display names, never raw ids
    await authedPage.locator('#new-team-access-picker').click()
    const seededOption = authedPage.getByRole('option', {
      name: HOST_DISPLAY_NAME,
      exact: true,
    })
    await expect(seededOption).toBeVisible({ timeout: 15_000 })
    await expect(authedPage.getByRole('option', { name: CONTEXT_ID, exact: true })).toHaveCount(0)
    await seededOption.click()
    await expect(authedPage.locator('#new-team-access-picker')).toContainText(HOST_DISPLAY_NAME)
    await authedPage.keyboard.press('Escape')

    // Last step: the primary action creates the team (no fourth step).
    await authedPage.getByRole('button', { name: 'Create team', exact: true }).click()
    await authedPage.waitForURL('**/users-and-teams/teams', { timeout: 30_000 })

    const teamId = await waitForTeamIdByName(TEAM_NAME)
    expect(teamId).not.toBe('')
    const { contextIds } = await controlApi.getTeamContexts(teamId)
    expect(contextIds ?? []).toContain(CONTEXT_ID)

    // D8 composite write: the wizard also persists the team↔agent mapping.
    const { agentNames } = await controlApi.getTeamAgents(teamId)
    expect(agentNames ?? []).toContain(HOST_NAME)

    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    // D8: one table row per granted agent, labelled by its display name.
    const row = authedPage
      .getByRole('row')
      .filter({ has: authedPage.getByRole('cell', { name: HOST_DISPLAY_NAME, exact: true }) })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).not.toContainText(CONTEXT_ID)
  })
})
