// control-ui/e2e/qa-recorder-member-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Records the D10 "Agents" rename evidence in Users & Teams — the Teams
// table 'Agents' column header (no 'Contexts' header on either table) — then
// the member detail Agents tab (D8 semantics, D10 name): a
// Control-API-seeded scope granted via PUT /users/<id>/contexts is shown as
// an agent row in the Agent/Connectors table, labelled by the owning host's
// display name (never the raw contextId), the 'Add agents' picker modal
// opens (agent display names) and cancels, and removal confirms ("Remove
// Agent") → toasts "Agents updated." → clears the row. The tab's writes are
// D8 composite writes (agents AND
// contexts mappings), so the member's original contextIds AND agentNames are
// restored and the seeded host + context are deleted in the finally (hosts
// before contexts).
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

test.describe('optional QA recorder: Control UI member Agents tab', () => {
  test('records the Users & Teams Agents headers and the member agents round-trip', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey grants and removes member access and seeds/deletes a host and context.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-member-access'
    const contextName = uniqueE2EName('qa-recorder-member-ctx')
    const contextId = uniqueE2EName('qa-recorder-member-scope')
    const hostName = uniqueE2EName('qa-recorder-member-host')
    const hostDisplayName = uniqueE2EName('qa-recorder-member-agent')
    let userId = ''
    let originalContextIds: string[] | null = null
    let originalAgentNames: string[] | null = null

    try {
      await loginThroughUi(page, credentials)

      // D10 evidence part 1 — Users table carries no 'Contexts' header.
      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
      await expect(page.getByRole('button', { name: 'Create member', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('columnheader', { name: 'Contexts' })).toHaveCount(0)
      await screenshotAndLog(page, testInfo, `${journey}-users-table`)

      // D10 evidence part 2 — Teams table column header is 'Agents' (a sort
      // button), still with no 'Contexts' header.
      const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
      await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
      await teamsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
      // Only assert the sortable header when the teams table rendered — a
      // fresh environment shows the empty state instead.
      const teamsTable = page.locator('table', { hasText: 'Team name' })
      if (await teamsTable.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await expect(teamsTable.getByRole('button', { name: 'Sort by agents' })).toBeVisible()
      } else {
        await expect(page.getByText('No teams yet.', { exact: true })).toBeVisible()
      }
      await expect(page.getByRole('columnheader', { name: 'Contexts' })).toHaveCount(0)
      await screenshotAndLog(page, testInfo, `${journey}-teams-table`)

      // Member detail — open the first user row from the directory.
      const usersRes = await api<{ items?: Array<{ id: string }> }>(
        page.request,
        'GET',
        '/api/v1/admin/users'
      )
      expect(usersRes.status, `list users: ${JSON.stringify(usersRes.data)}`).toBe(200)
      test.skip(
        (usersRes.data.items ?? []).length === 0,
        'No users seeded in this environment; skipping member access journey.'
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

      // Seed a host-backed scope out-of-band, remember the member's original
      // contextIds and agentNames, then grant the scope through the admin
      // context API.
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

      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId,
          description: 'QA recorder member access scope',
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
        `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`,
        { contextIds: [...originalContextIds, contextId] }
      )
      expect(grantRes.status, `grant user contexts: ${JSON.stringify(grantRes.data)}`).toBeLessThan(
        300
      )

      // Reload the tab: D8 renders granted access as a real table — one row
      // per granted agent, cell 1 the host display name (never the raw wire
      // contextId), cell 2 the shared Connectors count cell.
      await page.reload()
      await expect(
        page.getByText('Agents this member may use — and the connectors each one carries.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })
      await expect(page.getByRole('columnheader', { name: 'Agent', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page.getByRole('columnheader', { name: 'Connectors', exact: true })
      ).toBeVisible()
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayName, exact: true }) })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).not.toContainText(contextId)
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // 'Add agents' picker modal opens and cancels. The picker is labelled
      // 'Agents' and its options are agent display names.
      await page.getByRole('button', { name: 'Add agents', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add agents' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Agents')).toBeVisible()
      await expect(dialog.locator('#member-agent-picker')).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-add-modal`)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      // Remove the row: confirm dialog → toast → row gone.
      await row.getByLabel('Remove agent').click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Agent' })
      await expect(confirmDialog).toBeVisible()
      await expect(confirmDialog).toContainText(
        'This revokes the agent and every connector it carries.'
      )
      await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Agents updated.' })).toBeVisible({
        timeout: 20_000,
      })
      await expect(row.getByLabel('Remove agent')).toHaveCount(0)
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
      // D8 composite write: the tab's remove also rewrote the member↔agent
      // mapping, so restore the original agentNames too (PUT is
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
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
