// control-ui/e2e/qa-recorder-team-access-shared-label.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Creates a team through the Control API, seeds ONE host-backed access scope
// shared by TWO hosts, and grants it via PUT /teams/<id>/contexts. The team
// detail Access tab must render that shared scope as a SINGLE row labelled
// with both agent display names joined by ", " (lib/accessScopeLabels joins
// the sorted owner names), never two rows and never the raw contextId.
// Removal confirms with the joined label in the dialog text and toasts
// "Team access updated.". The team, hosts, and context are deleted via the
// Control API in the finally (hosts before the context).
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

test.describe('optional QA recorder: Control UI team Access shared-scope label', () => {
  test('records the joined shared-scope label on the team Access tab and its removal', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey creates and deletes a team, two hosts, and a context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-team-access-shared'
    const teamName = uniqueE2EName('qa-recorder-team-shared')
    const contextName = uniqueE2EName('qa-recorder-tas-ctx')
    const contextId = uniqueE2EName('qa-recorder-tas-scope')
    const hostNameA = uniqueE2EName('qa-recorder-tas-host-a')
    const hostNameB = uniqueE2EName('qa-recorder-tas-host-b')
    const hostDisplayA = uniqueE2EName('qa-recorder-tas-agent-a')
    const hostDisplayB = uniqueE2EName('qa-recorder-tas-agent-b')
    // accessScopeLabels joins the sorted owner names with ", " — the "a"
    // agent sorts before the "b" agent, so the joined label is deterministic.
    const joinedLabel = `${hostDisplayA}, ${hostDisplayB}`
    let teamId = ''

    try {
      await loginThroughUi(page, credentials)

      // Stage the team and its shared scope out-of-band; the behavior under
      // test is the Access tab presentation and removal round-trip.
      const teamRes = await api<{ id?: string }>(page.request, 'POST', '/api/v1/admin/teams', {
        name: teamName,
      })
      expect(teamRes.status, `create team: ${JSON.stringify(teamRes.data)}`).toBeLessThan(300)
      teamId = String(teamRes.data.id ?? '')

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId,
          description: 'QA recorder team shared access scope',
          mcpServers: [],
        },
      })
      expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

      for (const [hostName, hostDisplay] of [
        [hostNameA, hostDisplayA],
        [hostNameB, hostDisplayB],
      ] as const) {
        const hostRes = await api(page.request, 'POST', '/api/v1/admin/hosts', {
          metadata: { name: hostName },
          spec: {
            host: hostDisplay,
            contextRef: contextId,
            secretRef: '',
            channels: [],
          },
        })
        expect(hostRes.status, `create host: ${JSON.stringify(hostRes.data)}`).toBeLessThan(300)
      }

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

      const accessTab = page.getByRole('tab', { name: 'Access', exact: true })
      await accessTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/access$/, {
        timeout: 20_000,
      })

      // The shared scope renders as ONE row with the joined "A, B" label —
      // never the raw wire contextId, never one row per host.
      await expect(
        page.getByText('Agents and connector scopes this team may access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      const row = page.getByRole('listitem').filter({ hasText: joinedLabel })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).not.toContainText(contextId)
      await expect(page.getByRole('listitem').getByText(hostDisplayA, { exact: true })).toHaveCount(
        0
      )
      await expect(page.getByRole('listitem').getByText(hostDisplayB, { exact: true })).toHaveCount(
        0
      )
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // Remove the row: confirm dialog names the joined label → toast → row gone.
      await row.getByLabel('Remove access').click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Access' })
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(joinedLabel)
      await expect(confirmDialog).not.toContainText(contextId)
      await screenshotAndLog(page, testInfo, `${journey}-remove-confirm`)
      await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Team access updated.' })
      ).toBeVisible({ timeout: 20_000 })
      await expect(row.getByLabel('Remove access')).toHaveCount(0)
      await expect(page.getByText('No access assigned yet.', { exact: true })).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-removed`)
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
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostNameA)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostNameB)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
