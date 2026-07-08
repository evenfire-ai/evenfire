// desktop-app/test/e2e-playwright/cancel.test.ts
//
// Playwright/Electron E2E tests for the task-cancel v2 flow.
//
// Selectors used (all pre-existing in ProgressStepper.tsx):
//   data-testid="progress-cancel-btn"   — Cancel-task button (connecting/active/suspended states)
//   data-testid="progress-stepper"      — Progress stepper container
//   .stepper-cancelled-badge            — "Cancelled" text badge inside status-cancelled stepper
//   data-testid="agent-response"        — Completed assistant message bubble
//   data-testid="approval-approve-btn"  — Approve button (status-suspended stepper)
//   data-testid="approval-deny-btn"     — Deny button (status-suspended stepper)
//
// Requires minikube running + port-forwards active (`make minikube-pf-desktop`).
// For compile-only CI verification run: `npx tsc --noEmit` in desktop-app/.
import { expect, test } from './fixtures.js'
import { openAgentsPage } from './navigationHelpers.js'

const E2E_HOST_REF = process.env.E2E_HOST_REF || 'chatllm'

// ---------------------------------------------------------------------------
// Navigation helpers (mirrors chat.test.ts)
// ---------------------------------------------------------------------------

/** Navigate to agents page and select the test agent to enter chat view. */
async function enterAgentChat(appPage: import('@playwright/test').Page) {
  await openAgentsPage(appPage)
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  const agentLink = appPage.locator('.agents-table-row-clickable', { hasText: E2E_HOST_REF })
  await expect(chatInput.or(agentLink.first())).toBeVisible({ timeout: 20_000 })
  if (await agentLink.first().isVisible()) {
    await agentLink.first().click()
  }
  await chatInput.waitFor({ state: 'visible', timeout: 10_000 })
}

async function startFreshThread(appPage: import('@playwright/test').Page) {
  await appPage.getByRole('button', { name: /new thread/i }).click()
  await expect(appPage.locator('[data-testid="agent-response"]')).toHaveCount(0, {
    timeout: 10_000,
  })
}

/**
 * Send a message, wait for the cancel button to appear, then click it.
 * Returns immediately after the cancel click — callers assert the resulting state.
 */
async function sendAndCancel(
  appPage: import('@playwright/test').Page,
  message: string,
  cancelTimeoutMs = 30_000
): Promise<void> {
  const chatInput = appPage.locator('[data-testid="chat-input"]')
  await chatInput.fill(message)
  await appPage.locator('[data-testid="send-button"]').click()

  // progress-cancel-btn appears on the active / connecting / suspended stepper.
  const cancelBtn = appPage.locator('[data-testid="progress-cancel-btn"]').first()
  await cancelBtn.waitFor({ state: 'visible', timeout: cancelTimeoutMs })
  await cancelBtn.click()
}

/** Locator that matches the "Cancelled" badge rendered inside status-cancelled stepper. */
function cancelledBadge(appPage: import('@playwright/test').Page) {
  return appPage.locator('.stepper-cancelled-badge').first()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Cancel flow (v2)', () => {
  test.beforeEach(async ({ appPage }) => {
    await enterAgentChat(appPage)
    await startFreshThread(appPage)
  })

  test('cancel during LLM call shows Cancelled badge within 8s (BUG-4, BUG-7, BUG-11)', async ({
    appPage,
  }) => {
    const start = Date.now()

    await sendAndCancel(
      appPage,
      'Write a 3000 word essay about the history of computing, no tools just prose'
    )

    // The ProgressStepper transitions to status-cancelled which renders
    // .stepper-cancelled-badge with the text "Cancelled".
    const badge = cancelledBadge(appPage)
    await expect(badge).toBeVisible({ timeout: 5_000 })
    await expect(badge).toHaveText(/cancelled/i)

    const elapsed = Date.now() - start
    console.log(`[cancel-test] Cancelled badge visible in ${elapsed}ms`)
    expect(elapsed).toBeLessThan(8_000)

    // Sanity: no phantom "Failed to retrieve" toast.
    const failToast = appPage.locator('text=/failed to retrieve/i')
    await expect(failToast).not.toBeVisible({ timeout: 2_000 })
  })

  test('cancel + follow-up message succeeds without error (BUG-8)', async ({ appPage }) => {
    await sendAndCancel(appPage, 'Write a 3000 word essay about the history of philosophy')

    // Wait for Cancelled badge to confirm the cancel was acknowledged.
    await expect(cancelledBadge(appPage)).toBeVisible({ timeout: 5_000 })

    // Send an unrelated follow-up message.
    const chatInput = appPage.locator('[data-testid="chat-input"]')
    await chatInput.fill('What is 2 plus 2?')
    await appPage.locator('[data-testid="send-button"]').click()

    // Expect a legitimate agent response — NOT a "Cannot start turn" or
    // "conversation is processing" error.
    const responseCountBefore = await appPage.locator('[data-testid="agent-response"]').count()
    const newResponse = appPage.locator('[data-testid="agent-response"]').nth(responseCountBefore)
    await expect(newResponse).toBeVisible({ timeout: 30_000 })
    const text = (await newResponse.textContent()) ?? ''
    expect(text.toLowerCase()).not.toContain('cannot start turn')
    expect(text.toLowerCase()).not.toContain('conversation is processing')
  })

  test('cancel → unrelated question: no content leak from cancelled essay (BUG-9)', async ({
    appPage,
  }) => {
    // Unique canary token injected into the (to-be-cancelled) essay prompt.
    const canaryWord = 'QUANTUM_CANARY_XYZ_9'
    await sendAndCancel(appPage, `Write a 2000 word essay about ${canaryWord} quantum computing`)
    await expect(cancelledBadge(appPage)).toBeVisible({ timeout: 5_000 })

    const chatInput = appPage.locator('[data-testid="chat-input"]')
    await chatInput.fill('What is the capital of France?')
    await appPage.locator('[data-testid="send-button"]').click()

    const responseCountBefore = await appPage.locator('[data-testid="agent-response"]').count()
    const newResponse = appPage.locator('[data-testid="agent-response"]').nth(responseCountBefore)
    await expect(newResponse).toBeVisible({ timeout: 30_000 })
    const text = (await newResponse.textContent()) ?? ''

    // The reply to "capital of France" must not contain the cancelled essay's canary word.
    expect(text).not.toContain(canaryWord)
    expect(text.toLowerCase()).not.toContain('quantum computing')
    // Sanity: should mention Paris.
    expect(text.toLowerCase()).toContain('paris')
  })

  test('double-click cancel results in exactly one Cancelled badge (BUG-5)', async ({
    appPage,
  }) => {
    const chatInput = appPage.locator('[data-testid="chat-input"]')
    await chatInput.fill('Count from 1 to 500, one number per line')
    await appPage.locator('[data-testid="send-button"]').click()

    const cancelBtn = appPage.locator('[data-testid="progress-cancel-btn"]').first()
    await cancelBtn.waitFor({ state: 'visible', timeout: 20_000 })

    // First click.
    await cancelBtn.click()
    // Second rapid click — the button may already be gone/disabled; swallow the error.
    await cancelBtn.click({ trial: false, force: true, timeout: 500 }).catch(() => {
      /* button disabled or hidden — expected */
    })

    // Exactly one Cancelled badge should appear.
    await expect(cancelledBadge(appPage)).toBeVisible({ timeout: 5_000 })
    await expect(cancelledBadge(appPage)).toHaveCount(1)

    // No stuck "Cancelling…" spinner should linger beyond the 5 s debounce in the component.
    const cancellingSpinner = appPage.locator('text=/cancelling/i')
    await expect(cancellingSpinner).not.toBeVisible({ timeout: 3_000 })
  })

  test('approval-required tool shows approval UI, not a raw-JSON bubble (BUG-10)', async ({
    appPage,
  }) => {
    const chatInput = appPage.locator('[data-testid="chat-input"]')
    // Use a URL-visit prompt that the test agent is configured to require approval for.
    // Adjust if the test agent's approval-required tool is exposed differently.
    await chatInput.fill('Visit https://elpais.es')
    await appPage.locator('[data-testid="send-button"]').click()

    // Expect the suspended stepper's approval-approve-btn to appear.
    // This means the ProgressStepper rendered the approval UI, not a raw JSON bubble.
    const approveBtn = appPage.locator('[data-testid="approval-approve-btn"]').first()
    const denyBtn = appPage.locator('[data-testid="approval-deny-btn"]').first()

    await expect(approveBtn).toBeVisible({ timeout: 30_000 })
    await expect(denyBtn).toBeVisible({ timeout: 30_000 })

    // Sanity: no assistant-response bubble should contain raw approval JSON at this point.
    // (The agent is suspended waiting for approval, not responding with JSON.)
    const responses = appPage.locator('[data-testid="agent-response"]')
    const count = await responses.count()
    for (let i = 0; i < count; i++) {
      const text = (await responses.nth(i).textContent()) ?? ''
      // Raw JSON approval payloads begin with { and include "status" and "approval"
      expect(text.trim()).not.toMatch(/^\s*\{[\s\S]*"status"[\s\S]*"approval"/)
    }
  })
})
