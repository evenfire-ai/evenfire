/**
 * Control UI — Team create wizard Access step tests
 *
 * The wizard rail is Team → Members → Access → Agents; the Access step offers
 * agent display names (not raw scope ids) and a selection made there lands on
 * the created team as a real context mapping.
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

    await expect(authedPage.locator('.cu-agent-step-rail__title')).toHaveText([
      'Team',
      'Members',
      'Access',
      'Agents',
    ])

    // Step 1 — Team identity
    await authedPage.getByLabel('Team name').fill(TEAM_NAME)
    await authedPage.getByRole('button', { name: 'Continue', exact: true }).click()

    // Step 2 — Members: skip for now
    await authedPage.getByRole('button', { name: 'Skip', exact: true }).click()
    await expect(
      authedPage.getByText('Choose the agents and connector scopes this team can use.')
    ).toBeVisible({ timeout: 15_000 })

    // Step 3 — Access: options resolve to agent display names, never raw ids
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
    await authedPage.getByRole('button', { name: 'Continue', exact: true }).click()

    // Step 4 — Agents: none for this flow, then create
    await authedPage.getByRole('button', { name: 'Create team', exact: true }).click()
    await authedPage.waitForURL('**/users-and-teams/teams', { timeout: 30_000 })

    const teamId = await waitForTeamIdByName(TEAM_NAME)
    expect(teamId).not.toBe('')
    const { contextIds } = await controlApi.getTeamContexts(teamId)
    expect(contextIds ?? []).toContain(CONTEXT_ID)

    await authedPage.goto(`/users-and-teams/teams/${encodeURIComponent(teamId)}/access`)
    // Access rows are role="listitem" divs (.cu-access-row), not table rows.
    const row = authedPage.getByRole('listitem').filter({ hasText: HOST_DISPLAY_NAME })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await expect(row).not.toContainText(CONTEXT_ID)
  })
})
