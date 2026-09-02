// control-ui/e2e/qa-recorder-team-access-shared-label.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Creates a team through the Control API, seeds ONE host-backed access scope
// shared by TWO hosts, and grants it via PUT /teams/<id>/contexts. Under D8
// the granted set is agent-centric (the team↔agent mapping UNION legacy scope
// mappings resolved to their owning agents), so the shared scope renders as
// TWO table rows — one per agent display name — never a joined "A, B" label
// and never the raw contextId. Removal of ONE agent confirms with that
// agent's own display name; the shared scope stays mapped for the other
// agent, and the union resolves it back to BOTH owners, so both rows remain.
// Recorded on the team Agents tab (D8 semantics, D10 name). The team, hosts,
// and context are deleted via the Control API in the finally (hosts before
// the context).
//
// Contract: docs/testing/control-ui-headful-journeys.md.
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

test.describe('optional QA recorder: Control UI team Agents shared-scope rows', () => {
  test('records the per-agent shared-scope rows on the team Agents tab and a single-agent removal', async ({
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
    // Pre-D8 the shared scope rendered one row with the owners joined by
    // ", "; D8 renders one row per agent, so this joined label is only used
    // to assert it never appears.
    const joinedLabel = `${hostDisplayA}, ${hostDisplayB}`
    let teamId = ''

    try {
      await loginThroughUi(page, credentials)

      // Stage the team and its shared scope out-of-band; the behavior under
      // test is the Agents tab presentation and removal round-trip.
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

      // Open the team from the Users & Teams directory and switch to Agents.
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

      const agentsTab = page.getByRole('tab', { name: 'Agents', exact: true })
      await agentsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams\/[^/]+\/agents$/, {
        timeout: 20_000,
      })

      // D8: the granted set is agent-centric. The legacy scope grant
      // resolves to BOTH owning agents, so the shared scope renders as TWO
      // table rows — one per agent display name — never a joined "A, B"
      // label and never the raw contextId.
      await expect(
        page.getByText('Agents this team may use — and the connectors each one carries.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })
      const rowA = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayA, exact: true }) })
      const rowB = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayB, exact: true }) })
      await expect(rowA).toBeVisible({ timeout: 20_000 })
      await expect(rowB).toBeVisible({ timeout: 20_000 })
      await expect(rowA).not.toContainText(contextId)
      await expect(rowB).not.toContainText(contextId)
      await expect(page.getByRole('cell', { name: joinedLabel, exact: true })).toHaveCount(0)
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // Remove agent A: the confirm dialog names A alone (not the joined
      // label, not the raw id). Confirming revokes A's agent mapping, but
      // the shared scope stays mapped for B and the D8 union resolves it
      // back to BOTH owners, so both rows remain after the toast.
      await rowA.getByLabel('Remove agent').click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Agent' })
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(hostDisplayA)
      await expect(confirmDialog).not.toContainText(joinedLabel)
      await expect(confirmDialog).not.toContainText(contextId)
      await expect(confirmDialog).toContainText(
        'This revokes the agent and every connector it carries.'
      )
      await screenshotAndLog(page, testInfo, `${journey}-remove-confirm`)
      await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(
        page.getByRole('status').filter({ hasText: 'Team agents updated.' })
      ).toBeVisible({ timeout: 20_000 })
      await expect(rowA).toBeVisible({ timeout: 20_000 })
      await expect(rowB).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-removed-one-agent`)
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
