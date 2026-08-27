// control-ui/e2e/qa-recorder-team-create.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Creates an empty team through the create-team wizard, tours its detail tabs,
// then deletes the team via the Control API.
import { type Page, expect, test } from '@playwright/test'
import {
  CONTROL_API_URL,
  CONTROL_UI_URL,
  adminCredentials,
  api,
  assertAllowedTarget,
  loginThroughUi,
  requireRecorderConfirm,
  screenshotAndLog,
  uniqueE2EName,
} from './qa-recorder-helpers'

async function continueWizard(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: 'Continue', exact: true })
  await expect(next).toBeEnabled()
  await next.click()
}

test.describe('optional QA recorder: Control UI team creation', () => {
  test('records the create-team wizard and the team detail tab tour', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a team.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const teamName = uniqueE2EName('qa-recorder-team')
    let teamId = ''

    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

      const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
      await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
      await teamsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })

      const createTeam = page.getByRole('button', { name: 'Create team', exact: true })
      await expect(createTeam).toBeEnabled()
      await createTeam.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/new$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Create team', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await page.getByPlaceholder('Team name').fill(teamName)

      await continueWizard(page)
      await expect(
        page.getByText('Choose initial team members and roles.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await continueWizard(page)
      await expect(
        page.getByText('Choose the agents and connector scopes this team can use.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await continueWizard(page)
      await expect(
        page.getByText('Select the agents this team can use.', { exact: true })
      ).toBeVisible({
        timeout: 20_000,
      })

      const submit = page.getByRole('button', { name: 'Create team', exact: true })
      await expect(submit).toBeEnabled()
      await submit.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })

      const teamLink = page.getByRole('button', { name: teamName, exact: true })
      await expect(teamLink).toBeVisible({ timeout: 20_000 })
      await teamLink.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/members$/, {
        timeout: 20_000,
      })
      const match = page.url().match(/\/users-and-teams\/teams\/([^/]+)\//)
      teamId = decodeURIComponent(match?.[1] || '')

      await expect(page.getByRole('tablist', { name: 'Team sections' })).toBeVisible({
        timeout: 20_000,
      })

      const accessTab = page.getByRole('tab', { name: 'Access', exact: true })
      await accessTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/access$/, {
        timeout: 20_000,
      })
      await expect(accessTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: 'Add access', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      const agentsTab = page.getByRole('tab', { name: 'Agents', exact: true })
      await agentsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/agents$/, {
        timeout: 20_000,
      })
      await expect(agentsTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: 'Add agent', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      const membersTab = page.getByRole('tab', { name: 'Members', exact: true })
      await membersTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/members$/, {
        timeout: 20_000,
      })
      await expect(membersTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: 'Add member', exact: true })).toBeVisible({
        timeout: 20_000,
      })

      await screenshotAndLog(page, testInfo, 'control-ui-team-create')
    } finally {
      try {
        const request = page.request
        let idToDelete = teamId
        if (!idToDelete) {
          const { status, data } = await api<{ items?: Array<{ id: string; name: string }> }>(
            request,
            'GET',
            '/api/v1/admin/teams'
          )
          if (status === 200) {
            idToDelete = (data.items || []).find(team => team.name === teamName)?.id || ''
          }
        }
        if (idToDelete) {
          await api(request, 'DELETE', `/api/v1/admin/teams/${encodeURIComponent(idToDelete)}`)
        }
      } catch {
        // Best-effort cleanup; the disposable environment tolerates leftover teams.
      }
    }
  })
})
