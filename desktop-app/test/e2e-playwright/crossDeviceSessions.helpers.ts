import { type Page, expect } from '@playwright/test'
import { openAgentsPage } from './navigationHelpers.js'

export const USER_A_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL ?? 'test@clerum.io'
export const USER_B_EMAIL = process.env.E2E_DEV_LOGIN_EMAIL_2 ?? 'test2@clerum.io'
export const HOST_REF = process.env.E2E_HOST_REF ?? 'chatllm'
export const PROBE = 'probe: cross-device-sessions T1'

export type ChatSessionSummary = {
  chatId?: string
  id?: string
  title?: string
  turnCount?: number
}

export function sessionChatId(session: ChatSessionSummary): string | null {
  return session.chatId ?? session.id ?? null
}

export function remoteSessionTitle(chatId: string): string {
  return `Remote · ${chatId.slice(0, 8)}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export async function enterAgentChat(page: Page): Promise<void> {
  await openAgentsPage(page)
  const chatInput = page.getByTestId('chat-input')
  const agentRow = page.locator('.agents-table-row-clickable', { hasText: HOST_REF }).first()
  await expect(
    agentRow,
    `[cross-device] Expected authorized agent row for "${HOST_REF}" before opening chat.`
  ).toBeVisible({ timeout: 20_000 })

  await agentRow.getByRole('button', { name: `More actions for ${HOST_REF}` }).click()
  const actionsMenu = page.getByRole('menu')
  await expect(actionsMenu).toBeVisible({ timeout: 10_000 })
  const newChatAction = actionsMenu
    .getByRole('button', { name: /^New chat$/ })
    .or(actionsMenu.getByRole('menuitem', { name: /^New chat$/ }))
  await expect(newChatAction).toBeVisible({ timeout: 10_000 })
  await newChatAction.click()

  await expect(chatInput).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: /^Switch chat agent$/ })).toContainText(HOST_REF, {
    timeout: 30_000,
  })
}

export function sidebarSessionButton(page: Page, title: string) {
  return page.getByRole('button', { name: new RegExp(`^Open ${escapeRegExp(title)}(?:\\s|$)`) })
}

export async function listServerSessions(page: Page): Promise<ChatSessionSummary[]> {
  const result = await page.evaluate(async hostRef => {
    return await (window as any).clerum.rpc.listSessions(hostRef)
  }, HOST_REF)
  return Array.isArray(result?.items) ? (result.items as ChatSessionSummary[]) : []
}

export async function listLocalChats(page: Page): Promise<ChatSessionSummary[]> {
  const result = await page.evaluate(async hostRef => {
    return await (window as any).clerum.chat.list(hostRef)
  }, HOST_REF)
  return Array.isArray(result) ? (result as ChatSessionSummary[]) : []
}

export async function waitForLocalChatByTitle(
  page: Page,
  title: string,
  timeout = 20_000
): Promise<ChatSessionSummary> {
  await expect
    .poll(
      async () => {
        const sessions = await listLocalChats(page)
        return sessions.some(session => session.title === title && sessionChatId(session))
      },
      { timeout }
    )
    .toBe(true)

  const session = (await listLocalChats(page)).find(item => item.title === title)
  if (!session || !sessionChatId(session)) {
    throw new Error(`Expected local chat titled "${title}" for ${HOST_REF}`)
  }
  return session
}

export async function waitForServerSessionByChatId(
  page: Page,
  chatId: string,
  timeout = 20_000
): Promise<ChatSessionSummary> {
  await expect
    .poll(
      async () => {
        const sessions = await listServerSessions(page)
        return sessions.some(session => sessionChatId(session) === chatId)
      },
      { timeout }
    )
    .toBe(true)

  const session = (await listServerSessions(page)).find(item => sessionChatId(item) === chatId)
  if (!session) {
    throw new Error(`Expected server session ${chatId} for ${HOST_REF}`)
  }
  return session
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
