// control-ui/e2e/qa-recorder-member-invite.spec.ts
//
// Optional QA recorder journey (MUTATING, sends email). Requires
// QA_RECORDER_CONFIRM_MUTATIONS=1. Invites a member through the Control UI and
// cancels the pending invitation via the Control API. The invitation email is
// actually sent to the supplied address, so use a disposable mailbox.
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

type PendingInvitation = { id: string; email: string }

test.describe('optional QA recorder: Control UI member invitation', () => {
  test('records the create-member invitation flow', async ({ page }, testInfo) => {
    requireRecorderConfirm(
      'QA_RECORDER_CONFIRM_MUTATIONS',
      'This journey sends a member invitation email and cancels the invitation.'
    )
    assertAllowedTarget('CONTROL_UI_URL', CONTROL_UI_URL)
    assertAllowedTarget('CONTROL_API_URL', CONTROL_API_URL)

    const credentials = adminCredentials()
    const email = `${uniqueE2EName('qa-recorder-member')}@example.test`

    try {
      await loginThroughUi(page, credentials)

      await page.getByRole('link', { name: 'Users & Teams', exact: true }).click()
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

      const createMember = page.getByRole('button', { name: 'Create member', exact: true })
      await expect(createMember).toBeEnabled()
      await createMember.click()
      await expect(page).toHaveURL(/\/users-and-teams\/users\/new$/, { timeout: 20_000 })
      await expect(page.getByRole('heading', { name: 'Create member', exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        page.getByText('Create a pending invitation and send the invitation email.', {
          exact: true,
        })
      ).toBeVisible()

      await page.getByPlaceholder('Full name').fill('QA Recorder')
      await page.getByPlaceholder('user@example.com').fill(email)

      const continueButton = page.getByRole('button', { name: 'Continue', exact: true })
      await expect(continueButton).toBeEnabled()
      await continueButton.click()
      await expect(
        page.getByText('Place the invited member on a team now, or leave them unassigned.', {
          exact: true,
        })
      ).toBeVisible({ timeout: 20_000 })

      const sendInvite = page.getByRole('button', { name: 'Send invite', exact: true })
      await expect(sendInvite).toBeEnabled()
      await sendInvite.click()
      await expect(page.getByText(`Invitation sent to ${email}.`, { exact: true })).toBeVisible({
        timeout: 20_000,
      })
      await expect(page).toHaveURL(/\/users-and-teams\/users$/, { timeout: 20_000 })

      await screenshotAndLog(page, testInfo, 'control-ui-member-invite')
    } finally {
      try {
        const request = page.request
        const { status, data } = await api<{ items?: PendingInvitation[] }>(
          request,
          'GET',
          '/api/v1/admin/pending-invitations'
        )
        if (status === 200) {
          const invitationId =
            (data.items || []).find(invitation => invitation.email === email)?.id || ''
          if (invitationId) {
            await api(
              request,
              'DELETE',
              `/api/v1/admin/invitations/${encodeURIComponent(invitationId)}`
            )
          }
        }
      } catch {
        // Best-effort cleanup; the disposable environment tolerates leftover invitations.
      }
    }
  })
})
