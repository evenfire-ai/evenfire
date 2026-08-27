// control-ui/e2e/qa-recorder-member-removed-access.spec.ts
//
// Optional QA recorder journey (MUTATING). Requires QA_RECORDER_CONFIRM_MUTATIONS=1.
// Video-tours the member Access tab's tombstone story: a scope granted to a
// member whose backing Context is then deleted out-of-band renders under the
// "Removed access" heading (cu-deleted-access-heading) with the resolved
// agent display name and a "Deleted" marker — never a bare contextId row in
// the active table. The member's original contextIds are restored via PUT
// and the seeded host is deleted in the finally; the Context stays deleted
// (it is the journey's fixture), so it is never deleted twice.
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

test.describe('optional QA recorder: Control UI member removed access', () => {
  test('optional QA recorder: Control UI member removed access journey', async ({
    page,
  }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey grants member access, deletes the backing context, and seeds/deletes a host.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const journey = 'control-ui-member-removed-access'
    const contextName = uniqueE2EName('qa-member-removed-ctx')
    const contextId = uniqueE2EName('qa-member-removed-scope')
    const hostName = uniqueE2EName('qa-member-removed-host')
    const hostDisplayName = uniqueE2EName('qa-member-removed-agent')
    let userId = ''
    let originalContextIds: string[] | null = null
    let restored = false

    try {
      await loginThroughUi(page, credentials)

      // First member from the directory carries the journey.
      const usersRes = await api<{ items?: Array<{ id: string }> }>(
        page.request,
        'GET',
        '/api/v1/admin/users'
      )
      expect(usersRes.status, `list users: ${JSON.stringify(usersRes.data)}`).toBe(200)
      test.skip(
        (usersRes.data.items ?? []).length === 0,
        'No users seeded in this environment; skipping member removed access journey.'
      )
      userId = String(usersRes.data.items?.[0]?.id || '')
      expect(userId, 'first user id').toBeTruthy()

      // Remember the member's original contextIds before granting anything.
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

      // Seed: a host-backed scope, granted to the member.
      const ctxRes = await api(page.request, 'POST', '/api/v1/admin/contexts', {
        metadata: { name: contextName },
        spec: {
          contextId,
          description: 'QA recorder member removed access scope',
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
          model: { provider: 'openai', name: 'gpt-5.4-mini' },
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

      // Delete the backing context out-of-band. The host stays alive so the
      // tombstoned row can still resolve to the agent display name.
      const deleteRes = await api(
        page.request,
        'DELETE',
        `/api/v1/admin/contexts/${encodeURIComponent(contextName)}`
      )
      expect(deleteRes.status, `delete context: ${JSON.stringify(deleteRes.data)}`).toBeLessThan(
        300
      )

      // The Access tab renders the orphaned mapping under "Removed access".
      await page.goto(
        `${CONTROL_UI_URL}/users-and-teams/users/${encodeURIComponent(userId)}/access`
      )
      await expect(
        page.getByText('Agents and connector scopes this member may access.', { exact: true })
      ).toBeVisible({ timeout: 20_000 })

      await expect(
        page.locator('.cu-deleted-access-heading').filter({ hasText: 'Removed access' })
      ).toBeVisible({ timeout: 20_000 })

      const removedRow = page
        .getByRole('row')
        .filter({ has: page.getByRole('cell', { name: hostDisplayName, exact: true }) })
      await expect(removedRow).toBeVisible({ timeout: 20_000 })
      await expect(removedRow.getByText('Deleted', { exact: true })).toBeVisible()
      // The raw wire contextId never renders for the tombstone.
      await expect(removedRow).not.toContainText(contextId)
      await screenshotAndLog(page, testInfo, `${journey}-deleted-scope`)

      // Restore: the member's original contextIds, which never contained the
      // deleted scope. A lingering deletedContextIds entry is server-side
      // bookkeeping and fine to leave behind.
      const restoreRes = await api(
        page.request,
        'PUT',
        `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`,
        { contextIds: originalContextIds }
      )
      expect(
        restoreRes.status,
        `restore user contexts: ${JSON.stringify(restoreRes.data)}`
      ).toBeLessThan(300)
      restored = true
    } finally {
      // Best-effort cleanup. The context is already deleted — never delete it
      // again. Restore the member's grants only if the body never got to.
      try {
        if (userId && originalContextIds !== null && !restored) {
          await api(
            page.request,
            'PUT',
            `/api/v1/admin/users/${encodeURIComponent(userId)}/contexts`,
            { contextIds: originalContextIds }
          )
        }
        await api(page.request, 'DELETE', `/api/v1/admin/hosts/${encodeURIComponent(hostName)}`)
      } catch {
        // Ignore cleanup failures.
      }
    }
  })
})
