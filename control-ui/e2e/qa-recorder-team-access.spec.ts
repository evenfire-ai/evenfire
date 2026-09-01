// control-ui/e2e/qa-recorder-team-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Creates a team through the Control API, seeds a host-backed access scope,
// grants it via PUT /teams/<id>/contexts, then records the team detail Access
// tab (D8): subtitle "Members, connector access, and agents.", intro "Agents
// this team may use — and the connectors each one carries.", the Access /
// Connectors table whose rows are granted agents labelled by display name
// (never the raw contextId), the 'Add access' modal assertions, removal with
// the "Team access updated." toast, and the legacy /contexts and /agents deep
// links redirecting to /access. The team, host, and context are deleted via
// the Control API in the finally (hosts before contexts).
//
// Contract: docs/testing/optional-playwright-qa-recorder.md ("Extending the
// recorder").
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

test.describe('optional QA recorder: Control UI team Access tab', () => {
  test('records granting, reviewing, and removing team access plus the legacy redirect', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a team, a host, and a context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-team-access'
    const teamName = uniqueE2EName('qa-recorder-team-access')
    const contextName = uniqueE2EName('qa-recorder-team-ctx')
    const contextId = uniqueE2EName('qa-recorder-team-scope')
    const hostName = uniqueE2EName('qa-recorder-team-host')
    const hostDisplayName = uniqueE2EName('qa-recorder-team-agent')
    let teamId = ''

    try {
      await loginThroughUi(page, credentials)

      // Stage the team and its host-backed access scope out-of-band; the
      // behavior under test is the Access tab round-trip.
      const teamRes = await api<{ id?: string }>(page.request, 'POST', '/api/v1/admin/teams', {
        name: teamName,
      })
      expect(teamRes.status, `create team: ${JSON.stringify(teamRes.data)}`).toBeLessThan(300)
      teamId = String(teamRes.data.id ?? '')

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId,
          description: 'QA recorder team access scope',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      const hostRes = await api(page.request, 'POST', '/api/v1/admin/hosts', {
        metadata: { name: hostName },
        spec: {
          host: hostDisplayName,
          contextRef: contextId,
          secretRef: '',
          channels: [],
        },
      })
      expect(hostRes.status, `create host: ${JSON.stringify(hostRes.data)}`).toBeLessThan(300)

      const grantRes = await api(
        page.request,
        'PUT',
        `/api/v1/admin/teams/${encodeURIComponent(teamId)}/contexts`,
        { contextIds: [contextId] }
      )
      expect(grantRes.status, `grant team contexts: ${JSON.stringify(grantRes.data)}`).toBeLessThan(
        300
      )

      // Open the team from the Users & Teams directory and switch to Access.
      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
      const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
      await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
      await teamsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })

      const teamLink = page.getByRole('button', { name: teamName, exact: true })
      await expect(teamLink).toBeVisible({ timeout: 20_000 })
      await teamLink.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/members$/, {
        timeout: 20_000,
      })
      if (!teamId) {
        const match = page.url().match(/\/users-and-teams\/teams\/([^/]+)\//)
        teamId = decodeURIComponent(match?.[1] || '')
      }

      const accessTab = page.getByRole('tab', { name: 'Access', exact: true })
      await accessTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/access$/, {
        timeout: 20_000,
      })

      // Exact subtitle and intro; D8 renders granted access as a real table
      // — one row per granted agent, cell 1 the agent display name (never
      // the raw wire contextId), cell 2 the shared Connectors count cell.
      await expect(
        page.getByText('Members, connector access, and agents.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await expect(
        page.getByText('Agents this team may use — and the connectors each one carries.', {
          exact: true,
        })
      ).toBeVisible()
      await expect(page.getByRole('columnheader', { name: 'Access', exact: true })).toBeVisible()
      await expect(
        page.getByRole('columnheader', { name: 'Connectors', exact: true })
      ).toBeVisible()
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayName, exact: true }) })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).not.toContainText(contextId)
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // 'Add access' picker modal assertions, then cancel. The picker is
      // still labelled 'Access' but its options are agent display names.
      await page.getByRole('button', { name: 'Add access', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add access' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Access')).toBeVisible()
      await expect(dialog.locator('#team-access-picker')).toBeVisible()
      await expect(dialog.getByRole('button', { name: 'Add access', exact: true })).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-add-modal`)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      // Remove the row: confirm dialog → toast → row gone.
      await row.getByLabel('Remove access').click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Access' })
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(
        'This revokes the agent and every connector it carries.'
      )
      await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Team access updated.' })
      ).toBeVisible({ timeout: 20_000 })
      // The mapping moves to the "Removed access" tombstone (deleted history),
      // so the actionable row disappears but a read-only row may remain.
      await expect(row.getByLabel('Remove access')).toHaveCount(0)
      await expect(page.getByText('No access assigned yet.', { exact: true })).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-removed`)

      // Legacy /contexts and /agents deep links redirect to /access.
      await page.goto(
        `${CONTROL_UI_URL}/users-and-teams/teams/${encodeURIComponent(teamId)}/contexts`
      )
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/access$/, {
        timeout: 20_000,
      })
      await page.goto(
        `${CONTROL_UI_URL}/users-and-teams/teams/${encodeURIComponent(teamId)}/agents`
      )
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/access$/, {
        timeout: 20_000,
      })
      await screenshotAndLog(page, testInfo, `${journey}-legacy-redirect`)
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
        // Best-effort cleanup; the disposable environment tolerates leftovers.
      }
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
