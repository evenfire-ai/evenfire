import { type Page, expect } from '@playwright/test'
import { openAgentsPage } from './navigationHelpers.js'

export const USER_A_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL ?? 'test@clerum.io'
export const USER_B_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL_2 ?? 'test2@clerum.io'
export const HOST_REF = process.env.E2E_HOST_REF ?? 'chatllm'
export const PROBE = 'probe: cross-device-sessions T1'

export async function enterAgentChat(page: Page): Promise<void> {
  await openAgentsPage(page)
  const chatInput = page.locator('[data-testid="chat-input"]')
  const agentLink = page.locator('.agents-table-row-clickable', { hasText: HOST_REF })
  await expect(chatInput.or(agentLink.first())).toBeVisible({ timeout: 20_000 })
  if (await agentLink.first().isVisible()) {
    await agentLink.first().click()
  }
  await chatInput.waitFor({ state: 'visible', timeout: 10_000 })
}

export async function openChatListPanel(page: Page): Promise<void> {
  const panel = page.locator('.chat-list-panel')
  if (await panel.isVisible()) return
  await page.getByRole('button', { name: /view all/i }).click()
  await panel.waitFor({ state: 'visible', timeout: 5_000 })
}

export async function waitForAssistantResponse(
  page: Page,
  countBefore: number,
  timeoutMs: number
): Promise<void> {
  const responses = page.locator('[data-testid="agent-response"]')
  const approveBtn = page.locator('[data-testid="approval-approve-btn"]')
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const remainingMs = Math.max(1, deadline - Date.now())
    const waitMs = Math.min(1_000, remainingMs)
    const outcome = await Promise.race([
      responses
        .nth(countBefore)
        .waitFor({ state: 'visible', timeout: waitMs })
        .then(() => 'response' as const)
        .catch(() => null),
      approveBtn
        .first()
        .waitFor({ state: 'visible', timeout: waitMs })
        .then(() => 'approval' as const)
        .catch(() => null),
    ])

    if (outcome === 'response') return
    if (outcome === 'approval') {
      await approveBtn
        .first()
        .click()
        .catch(() => {
          /* may disappear between readiness wait and click */
        })
    }
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for assistant response (countBefore=${countBefore})`
  )
}
