// desktop-app/test/e2e-playwright/approvals.test.ts
//
// Render-level E2E for the pending approvals surface in the Desktop App.
//
// Scope:
//   - Asserts the notification bell button is present and clickable.
//   - Asserts clicking the bell opens the approvals panel with the current
//     inbox header and either the empty-state message or at least one approval
//     card — whichever the live backend returns.
//
// What this does NOT do:
//   - It does not mock the /workflow-approvals endpoint (external-rest-api is
//     assumed reachable via RPC_PROXY_BASE_URL / EXTERNAL_REST_API_BASE_URL).
//     For end-to-end correctness of an approval life cycle, see the bash suites:
//       scripts/e2e/e2e-workflow-approvals.sh
//       scripts/e2e/e2e-workflow-approvals-recovery.sh
//   - It does not exercise approve/deny — those are covered by the IPC unit
//     suite at desktop-app/test/rpcProxyClient.approval.test.ts.
//
// Rationale: keep notification panel render coverage in the Playwright suite.
import { expect, test } from '@playwright/test'
import { launchAndLogin } from './workflowUi'

test('pending approvals bell renders and opens the panel', async () => {
  const { app, page } = await launchAndLogin()

  try {
    const bell = page.getByRole('button', { name: 'Notifications and approvals' })

    await bell.click()

    const panel = page.getByRole('dialog', { name: 'Notifications and approvals' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('strong', { hasText: 'Inbox' })).toBeVisible()

    // Backend may return approval cards or the global empty state. Wait for a
    // user-visible panel state instead of a stale section heading.
    const approvalCard = panel.locator('.notification-item').first()
    const emptyState = panel.getByText('No notifications or pending approvals right now.')
    await expect(approvalCard.or(emptyState)).toBeVisible({ timeout: 10_000 })
  } finally {
    await app.close()
  }
})
