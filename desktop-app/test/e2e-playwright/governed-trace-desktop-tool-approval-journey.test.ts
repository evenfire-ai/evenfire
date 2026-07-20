import type { Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import {
  type TerminalApproval,
  readActiveDesktopSessionId,
  readTraceRows,
  terminalApproval,
} from './governedTraceDesktopApprovalEvidence.js'
import {
  CHATLLM_HOST_REF,
  approveNextToolCall,
  denyNextToolCall,
  enterChatllmChat,
  sendChatPrompt,
  startFreshThread,
  waitForAssistantResponse,
} from './workflowAgentChatTools.js'

const CONTROL_UI =
  process.env.CONTROL_UI_URL || process.env.CONTROL_UI_BASE_URL || 'http://127.0.0.1:3000'
const ADMIN_USER = process.env.E2E_ADMIN_USERNAME || process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASS ||
  process.env.TEST_ADMIN_PASSWORD

const HTTP_REQUEST_PROMPT = [
  'Use the native http_request tool exactly once to make a GET request to https://example.com/.',
  'Do not use another tool and do not answer without invoking http_request.',
  'Wait for me to decide the approval request in this app.',
].join(' ')

async function loginControlUi(page: Page): Promise<void> {
  if (!ADMIN_PASSWORD) {
    throw new Error('An explicit Control UI admin password is required for this E2E')
  }
  await page.goto(CONTROL_UI)
  const signIn = page.getByRole('button', { name: 'Sign in' }).last()
  const authenticatedNav = page.getByRole('navigation', { name: 'Main sections' })
  await expect(signIn.or(authenticatedNav)).toBeVisible({ timeout: 20_000 })
  if (await signIn.isVisible()) {
    await page.getByLabel('Username or email').fill(ADMIN_USER)
    await page.getByLabel('Password').fill(ADMIN_PASSWORD)
    await expect(signIn).toBeEnabled()
    await signIn.click()
  }
  await expect(authenticatedNav).toBeVisible({ timeout: 30_000 })

  const accountAlert = page.getByRole('status').filter({ hasText: 'Set up your admin email' })
  const remindLater = accountAlert.getByRole('button', { name: 'Remind me later' })
  if (await remindLater.isVisible().catch(() => false)) {
    await remindLater.click()
    await expect(accountAlert).toBeHidden()
  }
}

function promptHistoryEvidence(item: ReturnType<Page['locator']>) {
  return item
    .getByText(/^Prompt history: (disabled|none|expired|unavailable)$/)
    .or(item.getByRole('button', { name: /Reveal retained prompt|Check protected prompt history/ }))
}

test.describe('governed tracing Desktop tool approval journey', () => {
  test.setTimeout(360_000)

  test('one end-user session records a denied and then approved http_request', async ({
    appPage,
    browser,
  }) => {
    await enterChatllmChat(appPage)
    await startFreshThread(appPage)

    let desktopSessionId = ''
    let deniedTrace: TerminalApproval | null = null
    await test.step('end user requests http_request and denies the first approval', async () => {
      const denialCountBefore = await appPage.getByTestId('approval-deny-btn').count()
      const responseCountBefore = await sendChatPrompt(appPage, HTTP_REQUEST_PROMPT)
      const denialButton = appPage.getByTestId('approval-deny-btn').nth(denialCountBefore)
      const approvalStepper = appPage
        .getByTestId('progress-stepper')
        .filter({ has: appPage.getByTestId('approval-deny-btn') })
        .nth(denialCountBefore)

      await expect(denialButton).toBeVisible({ timeout: 180_000 })
      await expect(approvalStepper).toContainText(/HTTP requires approval/i)
      desktopSessionId = await readActiveDesktopSessionId(appPage)
      await denyNextToolCall(appPage, denialCountBefore)
      await expect(appPage.getByText(`Denied request for ${CHATLLM_HOST_REF}.`)).toBeVisible({
        timeout: 10_000,
      })

      const response = await waitForAssistantResponse(appPage, responseCountBefore, 60_000)
      await expect(response).toContainText(/http_request.*denied by the user/i)

      await expect
        .poll(
          () => {
            deniedTrace = terminalApproval(readTraceRows(desktopSessionId), 'denied')
            return deniedTrace?.sessionId === desktopSessionId
          },
          {
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
            message: 'the denied approval must be persisted with authoritative user attribution',
          }
        )
        .toBe(true)
    })
    if (!deniedTrace) throw new Error('Denied approval trace was not captured')

    let approvedTrace: TerminalApproval | null = null
    let approvedToolOutcome: 'succeeded' | null = null
    await test.step('the same end-user session retries http_request and approves it', async () => {
      const approvalCountBefore = await appPage.getByTestId('approval-approve-btn').count()
      const responseCountBefore = await sendChatPrompt(appPage, HTTP_REQUEST_PROMPT)
      const approvalButton = appPage.getByTestId('approval-approve-btn').nth(approvalCountBefore)
      const approvalStepper = appPage
        .getByTestId('progress-stepper')
        .filter({ has: appPage.getByTestId('approval-approve-btn') })
        .nth(approvalCountBefore)

      await expect(approvalButton).toBeVisible({ timeout: 180_000 })
      await expect(approvalStepper).toContainText(/HTTP requires approval/i)
      await approveNextToolCall(appPage, approvalCountBefore)
      await expect(appPage.getByText(`Approved request for ${CHATLLM_HOST_REF}.`)).toBeVisible({
        timeout: 10_000,
      })

      const response = await waitForAssistantResponse(appPage, responseCountBefore, 120_000)
      await expect(response).not.toContainText(/was denied by the user/i)

      await expect
        .poll(
          () => {
            const rows = readTraceRows(desktopSessionId)
            approvedTrace = terminalApproval(rows, 'approved')
            const requestIds = new Set(
              rows.filter(row => row.eventType === 'approval').map(row => row.requestId)
            )
            const deniedToolCalls = rows.filter(
              row => row.eventType === 'tool_call' && row.requestId === deniedTrace!.requestId
            )
            const approvedToolCalls = approvedTrace
              ? rows.filter(
                  row => row.eventType === 'tool_call' && row.requestId === approvedTrace!.requestId
                )
              : []
            const toolCall = approvedToolCalls[0]
            approvedToolOutcome = toolCall?.outcome === 'succeeded' ? 'succeeded' : null
            return {
              approved: approvedTrace !== null,
              distinctRequests: requestIds.size,
              deniedDidNotExecute: deniedToolCalls.length === 0,
              differentRuns: approvedTrace?.runId !== deniedTrace!.runId,
              sameSession: approvedTrace?.sessionId === deniedTrace!.sessionId,
              sameUser: approvedTrace?.userId === deniedTrace!.userId,
              toolCallCount: approvedToolCalls.length,
              toolKind: toolCall?.toolKind ?? null,
              toolName: toolCall?.toolName ?? null,
              toolOutcome: toolCall?.outcome ?? null,
              toolSourceRef: toolCall?.toolSourceRef ?? null,
            }
          },
          {
            timeout: 90_000,
            intervals: [500, 1_000, 2_000],
            message: 'the approved request must correlate to one observed tool execution',
          }
        )
        .toEqual({
          approved: true,
          distinctRequests: 2,
          deniedDidNotExecute: true,
          differentRuns: true,
          sameSession: true,
          sameUser: true,
          toolCallCount: 1,
          toolKind: 'internal_tool',
          toolName: 'http_request',
          toolOutcome: 'succeeded',
          toolSourceRef: 'mcp-host',
        })
    })
    if (!approvedTrace || !approvedToolOutcome) {
      throw new Error('Approved tool execution trace was not captured')
    }

    await test.step('operator opens the direct Control UI route for the same Run replay session', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await loginControlUi(page)
        await page.goto(`${CONTROL_UI}/traces`)
        await expect(page).toHaveURL(new RegExp(`${CONTROL_UI}/traces$`))

        const sessionLink = page.getByRole('link', {
          name: deniedTrace!.sessionId,
          exact: true,
        })
        await expect(sessionLink).toBeVisible({ timeout: 30_000 })
        const sessionRow = page.getByRole('row').filter({ hasText: deniedTrace!.sessionId })
        await expect(sessionRow).toContainText('2 requested')
        await expect(sessionRow).toContainText('1 approved')
        await expect(sessionRow).toContainText('1 denied')
        await expect(
          sessionRow.locator(`a[href="/profile-admin/users/${deniedTrace!.userId}"]`)
        ).toBeVisible()
        await sessionLink.click()

        await expect(page).toHaveURL(
          new RegExp(
            `/traces/sessions/${encodeURIComponent(CHATLLM_HOST_REF)}/${encodeURIComponent(deniedTrace!.sessionId)}$`
          )
        )
        await expect(page.getByText('Session replay', { exact: true })).toBeVisible()
        const identity = page.locator('.cu-trace-detail-identity')
        await expect(identity).toContainText(deniedTrace!.sessionId)
        await expect(identity).toContainText(CHATLLM_HOST_REF)
        await expect(identity).toContainText('Status: verified')
        await expect(
          identity.locator(`a[href="/profile-admin/users/${deniedTrace!.userId}"]`)
        ).toBeVisible()
        await expect(page.getByRole('group', { name: 'Session metrics' })).toContainText(
          '1 approved · 1 denied'
        )

        const toolSection = page.locator('section[aria-labelledby="trace-session-tools"]')
        const toolRow = toolSection.getByRole('row').filter({ hasText: 'http_request' })
        await expect(toolRow).toBeVisible()
        await expect(toolRow.locator('td[data-label="Type"]')).toHaveText('internal tool')
        await expect(toolRow.locator('td[data-label="Source"]')).toHaveText('mcp-host')
        await expect(toolRow.locator('td[data-label="Calls"]')).toHaveText('1')
        await expect(toolRow.locator('td[data-label="Succeeded"]')).toHaveText('1')

        const approvalSection = page.locator('section[aria-labelledby="trace-session-approvals"]')
        await expect(approvalSection).toContainText('2 loaded')
        const deniedItem = approvalSection
          .getByRole('listitem')
          .filter({ hasText: deniedTrace!.requestId })
        const approvedItem = approvalSection
          .getByRole('listitem')
          .filter({ hasText: approvedTrace!.requestId })

        await expect(deniedItem.getByText('denied', { exact: true })).toBeVisible()
        await expect(deniedItem).toContainText('http_request')
        await expect(deniedItem).toContainText('Not executed (approval denied)')
        await expect(
          deniedItem.locator(`a[href="/profile-admin/users/${deniedTrace!.userId}"]`)
        ).toBeVisible()
        await expect(promptHistoryEvidence(deniedItem)).toBeVisible()

        await expect(approvedItem.getByText('approved', { exact: true })).toBeVisible()
        await expect(approvedItem).toContainText('http_request')
        await expect(approvedItem).toContainText(approvedToolOutcome)
        await expect(
          approvedItem.locator(`a[href="/profile-admin/users/${approvedTrace!.userId}"]`)
        ).toBeVisible()
        await expect(promptHistoryEvidence(approvedItem)).toBeVisible()
      } finally {
        await context.close()
      }
    })
  })
})
