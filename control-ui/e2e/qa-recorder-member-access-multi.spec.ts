// control-ui/e2e/qa-recorder-member-access-multi.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Records the member detail Agents tab multi-select add flow (D8 semantics,
// D10 name): two host-backed scopes are seeded out-of-band (one context +
// one host each), then the "Add agents" picker — options are AGENT display
// names — selects BOTH at once and submits — toast "Agents updated." — and
// both rows render in the Agent/Connectors table with the agent display
// names (never the raw contextIds). Each row is then removed through its
// confirm dialog. The tab's
// writes are D8 composite writes (agents AND contexts mappings), so the
// member's original contextIds AND agentNames are restored and the seeded
// hosts + contexts are deleted in the finally (hosts before contexts).
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

test.describe('optional QA recorder: Control UI member Agents multi-select', () => {
  test('records adding and removing two member agents in one picker submit', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey grants and removes member access and seeds/deletes two hosts and contexts.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-member-access-multi'
    const contextNameA = uniqueE2EName('qa-recorder-mam-ctx-a')
    const contextIdA = uniqueE2EName('qa-recorder-mam-scope-a')
    const contextNameB = uniqueE2EName('qa-recorder-mam-ctx-b')
    const contextIdB = uniqueE2EName('qa-recorder-mam-scope-b')
    const hostNameA = uniqueE2EName('qa-recorder-mam-host-a')
    const hostNameB = uniqueE2EName('qa-recorder-mam-host-b')
    const hostDisplayA = uniqueE2EName('qa-recorder-mam-agent-a')
    const hostDisplayB = uniqueE2EName('qa-recorder-mam-agent-b')
    let userId = ''
    let originalContextIds: string[] | null = null
    let originalAgentNames: string[] | null = null

    try {
      await loginThroughUi(page, credentials)

      // Member detail — open the first user row from the directory.
      const usersRes = await api<{ items?: Array<{ id: string }> }>(
        page.request,
        'GET',
        '/api/v1/admin/users'
      )
      expect(usersRes.status, `list users: ${JSON.stringify(usersRes.data)}`).toBe(200)
      test.skip(
        (usersRes.data.items ?? []).length === 0,
        'No users seeded in this environment; skipping member access multi journey.'
      )

      await page.goto(`${CONTROL_UI_URL}/users-and-teams/users`)
      const firstMemberRow = page.locator('tr[aria-label^="Open member "]').first()
      await expect(firstMemberRow).toBeVisible({ timeout: 20_000 })
      await firstMemberRow.click()
      await expect(page).toHaveURL(/\/users-and-teams\/users\/[^/]+/, { timeout: 20_000 })
      const match = page.url().match(/\/users-and-teams\/users\/([^/?#]+)/)
      userId = decodeURIComponent(match?.[1] || '')
      expect(userId, 'member id from detail URL').toBeTruthy()

      const memberTabs = page.getByRole('tablist', { name: 'Member sections' })
      await expect(memberTabs).toBeVisible({ timeout: 20_000 })
      const agentsTab = memberTabs.getByRole('tab', { name: 'Agents', exact: true })
      await expect(agentsTab).toBeVisible()
      await agentsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/users\/[^/]+\/agents$/, {
        timeout: 20_000,
      })
      await expect(
        page.getByText('Agents this member may use — and the connectors each one carries.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-tab`)

      // Remember the member's original contextIds and agentNames before any
      // mutation — the tab's writes are D8 composite writes.
      const originalRes = await api<{ contextIds?: string[] }>(
        page.request,
        'GET',
        `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`
      )
      expect(
        originalRes.status,
        `get user contexts: ${JSON.stringify(originalRes.data)}`
      ).toBeLessThan(300)
      originalContextIds = originalRes.data.contextIds ?? []

      const originalAgentsRes = await api<{ agentNames?: string[] }>(
        page.request,
        'GET',
        `/api/v1/admin/users/${encodeURIComponent(userId)}/agents`
      )
      expect(
        originalAgentsRes.status,
        `get user agents: ${JSON.stringify(originalAgentsRes.data)}`
      ).toBeLessThan(300)
      originalAgentNames = originalAgentsRes.data.agentNames ?? []

      // Seed two host-backed scopes out-of-band; the behavior under test is
      // the picker granting BOTH in a single submit.
      for (const [contextName, contextId, hostName, hostDisplay] of [
        [contextNameA, contextIdA, hostNameA, hostDisplayA],
        [contextNameB, contextIdB, hostNameB, hostDisplayB],
      ] as const) {
        const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
          metadata: { name: contextName },
          spec: {
            contextId,
            description: 'QA recorder member access multi scope',
            mcpServers: [],
          },
        })
        expect(ctxRes.status, `create context: ${JSON.stringify(ctxRes.data)}`).toBeLessThan(300)

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

      // Reload the tab so the picker offers the freshly seeded agents, then
      // select BOTH agent display names at once and submit.
      await page.reload()
      await expect(
        page.getByText('Agents this member may use — and the connectors each one carries.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })

      await page.getByRole('button', { name: 'Add agents', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add agents' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Agents')).toBeVisible()
      await expect(dialog.locator('#member-agent-picker')).toBeVisible()
      const optionA = dialog.getByRole('option', { name: hostDisplayA, exact: true })
      const optionB = dialog.getByRole('option', { name: hostDisplayB, exact: true })
      await expect(optionA).toBeVisible({ timeout: 20_000 })
      await expect(optionB).toBeVisible({ timeout: 20_000 })
      await optionA.click()
      await optionB.click()
      await expect(optionA).toHaveAttribute('aria-selected', 'true')
      await expect(optionB).toHaveAttribute('aria-selected', 'true')
      await screenshotAndLog(page, testInfo, `${journey}-add-modal`)
      await dialog.getByRole('button', { name: 'Add agents', exact: true }).click()

      // One toast, both rows — D8 renders one table row per granted agent,
      // each labelled with its agent display name, never the raw wire
      // contextId.
      await expect(
        page.getByRole('status').filter({ hasText: 'Agents updated.' }).first()
      ).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('columnheader', { name: 'Agent', exact: true })).toBeVisible()
      await expect(
        page.getByRole('columnheader', { name: 'Connectors', exact: true })
      ).toBeVisible()
      const rowA = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayA, exact: true }) })
      const rowB = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayB, exact: true }) })
      await expect(rowA).toBeVisible({ timeout: 20_000 })
      await expect(rowB).toBeVisible({ timeout: 20_000 })
      await expect(rowA).not.toContainText(contextIdA)
      await expect(rowB).not.toContainText(contextIdB)
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // Remove both rows: confirm dialog → toast → row gone, one at a time.
      for (const row of [rowA, rowB]) {
        await row.getByLabel('Remove agent').click()
        const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Agent' })
        await expect(confirmDialog).toBeVisible()
        await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click()
        await expect(
          page.getByRole('status').filter({ hasText: 'Agents updated.' }).first()
        ).toBeVisible({
          timeout: 20_000,
        })
        await expect(row.getByLabel('Remove agent')).toHaveCount(0)
      }
      await screenshotAndLog(page, testInfo, `${journey}-removed`)
    } finally {
      if (userId && originalContextIds !== null) {
        await api(
          page.request,
          'PUT',
          `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`,
          { contextIds: originalContextIds }
        )
      }
      // D8 composite write: the picker submit and removals also rewrote the
      // member↔agent mapping, so restore the original agentNames too (PUT is
      // compare-and-swap: echo the full set we currently observe).
      if (userId && originalAgentNames !== null) {
        const currentAgentsRes = await api<{
          agentNames?: string[]
          deletedAgentNames?: string[]
        }>(page.request, 'GET', `/api/v1/admin/users/${encodeURIComponent(userId)}/agents`)
        if (currentAgentsRes.status < 300) {
          await api(
            page.request,
            'PUT',
            `/api/v1/admin/users/${encodeURIComponent(userId)}/agents`,
            {
              agentNames: originalAgentNames,
              expectedCurrentAgentNames: [
                ...(currentAgentsRes.data.agentNames ?? []),
                ...(currentAgentsRes.data.deletedAgentNames ?? []),
              ],
            }
          )
        }
      }
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostNameA)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostNameB)}`)
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/contexts/${encodeURIComponent(contextNameA)}`
      )
      await api(
        page.request,
        'DELETE',
        `/api/v1/admin/contexts/${encodeURIComponent(contextNameB)}`
      )
    }
  })
})
