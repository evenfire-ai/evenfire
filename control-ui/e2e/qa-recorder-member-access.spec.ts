// control-ui/e2e/qa-recorder-member-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Records the E6 "Access" rename evidence in Users & Teams — the Teams table
// 'Access' column header (no 'Contexts' header on either table) — then the
// member detail Access tab: a Control-API-seeded scope granted via PUT
// /users/<id>/contexts is shown by its agent display name (never the raw
// contextId), the 'Add access' picker modal opens and cancels, and removal
// confirms ("Remove Access") → toasts "Access updated." → clears the row. The
// member's original contextIds are restored and the seeded host + context are
// deleted in the finally (hosts before contexts).
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

test.describe('optional QA recorder: Control UI member Access tab', () => {
  test('records the Users & Teams Access headers and the member access round-trip', async ({
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

    try {
      await loginThroughUi(page, credentials)

      // E6 evidence part 1 — Users table carries no 'Contexts' header.
      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })
      await expect(page.getByRole('button', { name: 'Create member', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByRole('columnheader', { name: 'Contexts' })).toHaveCount(0)
      await screenshotAndLog(page, testInfo, `${journey}-users-table`)

      // E6 evidence part 2 — Teams table column header is 'Access' (a sort
      // button), still with no 'Contexts' header.
      const teamsTab = page.getByRole('tab', { name: 'Teams', exact: true })
      await expect(teamsTab).toBeEnabled({ timeout: 20_000 })
      await teamsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/teams$/, { timeout: 20_000 })
      await expect(
        page
          .locator('table', { hasText: 'Team name' })
          .getByRole('button', { name: 'Sort by access' })
      ).toBeVisible({ timeout: 20_000 })
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
      const accessTab = memberTabs.getByRole('tab', { name: 'Access', exact: true })
      await expect(accessTab).toBeVisible()
      await accessTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/users\/[^/]+\/access$/, {
        timeout: 20_000,
      })
      await expect(
        page.getByText('Agents and connector scopes this member may access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      await screenshotAndLog(page, testInfo, `${journey}-tab`)

      // Seed a host-backed scope out-of-band, remember the member's original
      // contextIds, then grant the scope through the admin context API.
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

      // Reload the tab: the row shows the host display name, never the raw
      // wire contextId.
      await page.reload()
      await expect(
        page.getByText('Agents and connector scopes this member may access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayName, exact: true }) })
      await expect(row).toBeVisible({ timeout: 20_000 })
      await expect(row).not.toContainText(contextId)
      await screenshotAndLog(page, testInfo, `${journey}-granted`)

      // 'Add access' picker modal opens and cancels.
      await page.getByRole('button', { name: 'Add access', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Add access' })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Access')).toBeVisible()
      await screenshotAndLog(page, testInfo, `${journey}-add-modal`)
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)

      // Remove the row: confirm dialog → toast → row gone.
      await row.getByLabel('Remove access').click()
      const confirmDialog = page.getByRole('alertdialog', { name: 'Remove Access' })
      await expect(confirmDialog).toBeVisible()
      await confirmDialog.getByRole('button', { name: 'Remove access', exact: true }).click()
      await expect(page.getByRole('status').filter({ hasText: 'Access updated.' })).toBeVisible({
        timeout: 20_000,
      })
      await expect(row.getByLabel('Remove access')).toHaveCount(0)
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
      await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostName)}`)
      await api(page.request, 'DELETE', `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`)
    }
  })
})
