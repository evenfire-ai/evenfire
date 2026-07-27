// control-ui/e2e/qa-recorder-admin-invite.spec.ts
//
// Optional QA recorder journey (MUTATING, sends email). Requires
// QA_RECORDER_CONFIRM_MUTATIONS=1. Invites a Control UI admin (without Desktop
// App access) and cancels the invitation via the Control API. The invitation
// email is actually sent to the supplied address, so use a disposable mailbox.
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

type ControlAdminInvitation = { id: string; email: string; status: string }

test.describe('optional QA recorder: Control UI admin invitation', () => {
  test('records the invite-admin flow without Desktop App access', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey sends a Control UI admin invitation email and cancels the invitation.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const email = `${uniqueE2EName('qa-recorder-admin')}@example.test`

    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

      const adminsTab = page.getByRole('tab', { name: 'Admins', exact: true })
      await expect(adminsTab).toBeEnabled({ timeout: 20_000 })
      await adminsTab.click()
      await expect(page).toHaveURL(/\/users-and-teams\/admins$/, { timeout: 20_000 })

      const inviteAdmin = page.getByRole('button', { name: 'Invite admin', exact: true })
      await expect(inviteAdmin).toBeEnabled()
      await inviteAdmin.click()
      await expect(page).toHaveURL(/\/users-and-teams\/admins\/new$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Invite admin', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page.getByText('Invite a new Control UI admin.', { exact: true })).toBeVisible()

      await page.getByPlaceholder('admin@example.com').fill(email)

      const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
      await expect(continueButton).toBeEnabled()
      await continueButton.click()
      await expect(page.getByText('Control UI admin', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      const desktopAccess = page.getByRole('checkbox', { name: /Create access to Desktop App/ })
      await expect(desktopAccess).toBeVisible()
      await expect(desktopAccess).not.toBeChecked()

      const sendInvite = page.getByRole('button', { name: 'Send invite', exact: true })
      await expect(sendInvite).toBeEnabled()
      await sendInvite.click()
      await expect(page.getByText('Admin invitation sent.', { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page).toHaveURL(/\/users-and-teams\/admins$/, { timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-admin-invite')
    } finally {
      try {
        const request = page.request
        const { status, data } = await api<{ invitations?: ControlAdminInvitation[] }>(
          request,
          'GET',
          '/api/v1/admin/control-admins'
        )
        if (status === 200) {
          const invitationId =
            (data.invitations || []).find(invitation => invitation.email === email)?.id || ''
          if (invitationId) {
            await api(
              request,
              'DELETE',
              `/api/v1/admin/control-admin-invitations/${encodeURIComponent(invitationId)}`
            )
          }
        }
      } catch {
        // Best-effort cleanup; the disposable environment tolerates leftover invitations.
      }
    }
  })
})
