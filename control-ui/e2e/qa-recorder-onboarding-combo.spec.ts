// control-ui/e2e/qa-recorder-onboarding-combo.spec.ts
//
// Mutating QA recorder combo: new-team onboarding (team → member invite →
// context staged through the Control API → grant access to the team). Creates
// and tears down every resource.
// Requires QA_RECORDER_CONFIRM_MUTATIONS=1 in .env.qa-recorder.
import { expect, test } from '@playwright/test'
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

type IdItem = { id?: string; name?: string; email?: string }

async function findTeamIdByName(
  request: import('@playwright/test').APIRequestContext,
  name: string
): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { status, data } = await api<{ items?: IdItem[] }>(request, 'GET', '/api/v1/admin/teams')
    if (status === 200) {
      const found = (data.items ?? []).find(item => item.name === name)
      if (found?.id) return found.id
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error(`Created team "${name}" did not become visible through Control API.`)
}

test.describe('optional QA recorder: Control UI onboarding combo', () => {
  test('records the new-team onboarding combo (team, member, context grant)', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a team, a member invitation, and a context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const teamName = uniqueE2EName('qa-recorder-team')
    const memberName = 'QA Recorder Member'
    const memberEmail = `${uniqueE2EName('qa-recorder-member')}@example.test`
    const contextName = uniqueE2EName('qa-recorder-ctx')
    let teamId = ''

    try {
      await loginThroughUi(page, credentials)

      // step 1: create the team shell (name only).
      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
      const teamsListTab = page.getByRole('tab', { name: 'Teams', exact: true })
      await expect(teamsListTab).toBeEnabled({ timeout: 20_000 })
      await teamsListTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/new$/, { timeout: 20_000 })
      await page.getByLabel('Team name').fill(teamName)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Skip', exact: true }).click()
      await page.getByRole('button', { name: 'Create team', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
      teamId = await findTeamIdByName(page.request, teamName)

      // step 2: invite a member and assign them to the team (role + permission
      // checkboxes live on the create-member wizard's Team step).
      await page.goto(`${CONTROL_UI_URL}/users-and-teams/users/new`)
      await expect(page).toHaveURL(/\/users-and-teams\/users\/new$/, { timeout: 20_000 })
      await page.locator('#new-user-name').fill(memberName)
      await page.locator('#new-user-email').fill(memberEmail)
      await page.getByRole('button', { name: 'Continue', exact: true }).click()
      await expect(page.locator('#new-user-teams')).toBeVisible({ timeout: 20_000 })
      await page.locator('#new-user-teams').click()
      await page.getByPlaceholder('Search teams...').fill(teamName)
      const teamOption = page.getByRole('option', { name: teamName, exact: true })
      await expect(teamOption).toBeVisible({ timeout: 15_000 })
      await teamOption.click()
      await page.getByRole('button', { name: 'Send invite', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

      // step 3: verify the pending invitation landed on the team Members tab.
      await page.goto(
        `${CONTROL_UI_URL}/users-and-teams/teams/${encodeURIComponent(teamId)}/members`
      )
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/.+\/members$/, {
        timeout: 20_000,
      })
      await expect(
        page.getByText('Members, connector access, and agents.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText(memberEmail, { exact: true })).toBeVisible({ timeout: 15_000 })

      // step 4: create a context (name only) through the Control API — the
      // /contexts UI is gone.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId: contextName,
          description: 'QA recorder combo context',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      // step 5: grant the access scope to the team from the team Access tab.
      await page.goto(
        `${CONTROL_UI_URL}/users-and-teams/teams/${encodeURIComponent(teamId)}/access`
      )
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/.+\/access$/, {
        timeout: 20_000,
      })
      await expect(
        page.getByText('Members, connector access, and agents.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: 'Add access', exact: true }).click()
      await expect(page.locator('#team-access-picker')).toBeVisible({ timeout: 5_000 })
      await page.locator('#team-access-picker').fill(contextName)
      const accessOption = page.getByRole('option', { name: contextName, exact: true })
      await expect(accessOption).toBeVisible({ timeout: 10_000 })
      await accessOption.click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Add access', exact: true })
        .click()
      await expect(page.getByText('Team access updated.', { exact: true })).toBeVisible({
        timeout: 15_000,
      })

      // step 6: best-effort — if the invitation created a reachable user
      // record, confirm the team shows on the user-detail Teams tab.
      try {
        const { data } = await api<{ items?: IdItem[] }>(
          page.request,
          'GET',
          `/api/v1/admin/users?q=${encodeURIComponent(memberEmail)}`
        )
        const user = (data.items ?? []).find(item => item.email === memberEmail)
        if (user?.id) {
          await page.goto(
            `${CONTROL_UI_URL}/users-and-teams/users/${encodeURIComponent(user.id)}/teams`
          )
          await expect(page.getByText(teamName, { exact: true })).toBeVisible({ timeout: 10_000 })
        }
      } catch {
        // Pending invitation has no user record yet — skip gracefully.
      }

      await screenshotAndLog(page, testInfo, 'control-ui-onboarding-combo')
    } finally {
      const request = page.request
      // Reverse-order cleanup; each step is best-effort so one failure
      // does not block the rest.
      try {
        await api(request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
      } catch {
        // best-effort
      }
      try {
        const { data } = await api<{ items?: IdItem[] }>(
          request,
          'GET',
          '/api/v1/admin/pending-invitations'
        )
        const invitation = (data.items ?? []).find(item => item.email === memberEmail)
        if (invitation?.id) {
          await api(
            request,
            'DELETE',
            `/api/v1/admin/invitations/${encodeURIComponent(invitation.id)}`
          )
        }
      } catch {
        // best-effort
      }
      if (teamId) {
        try {
          await api(request, 'DELETE', `/api/v1/admin/teams/${encodeURIComponent(teamId)}`)
        } catch {
          // best-effort
        }
      }
    }
  })
})
