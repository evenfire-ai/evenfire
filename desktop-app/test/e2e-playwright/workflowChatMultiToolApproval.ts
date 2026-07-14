import { type Locator, type Page, expect } from '@playwright/test'
import { humanClick } from './workflowAgentChatTools'

type ToolApprovalExpectation = {
  approvalRequired?: boolean
  requiredText?: RegExp[]
  forbiddenText?: RegExp[]
}

export async function sendChatPromptAndApproveToolCallsUntilText(
  page: Page,
  prompt: string,
  expectedText: RegExp[],
  responseTimeout = 420_000,
  approvalExpectation: ToolApprovalExpectation = {}
): Promise<Locator> {
  const responseCountBefore = await sendChatPromptForApprovalJourney(page, prompt)
  const response = page.getByTestId('agent-response').nth(responseCountBefore)
  let approvedMatchingTool = false
  const deadline = Date.now() + responseTimeout

  while (Date.now() < deadline) {
    const approvalButton = await findVisibleMatchingApprovalButton(page, approvalExpectation)
    if (approvalButton) {
      approvedMatchingTool = true
      await humanClick(approvalButton, { beforeMs: [700, 1_200], afterMs: [700, 1_200] })
      await page.waitForTimeout(800)
      continue
    }

    if (await response.isVisible().catch(() => false)) {
      const responseText = ((await response.textContent().catch(() => '')) || '').trim()
      const textMatches = expectedText.every(pattern => pattern.test(responseText))
      if (textMatches && (!approvalExpectation.approvalRequired || approvedMatchingTool)) {
        return response
      }
    }

    await page.waitForTimeout(500)
  }

  const responseText = ((await response.textContent().catch(() => '')) || '').trim()
  throw new Error(
    [
      'Timed out waiting for approved chat tool journey.',
      `approvedMatchingTool=${approvedMatchingTool}`,
      `expectedTextMatched=${expectedText.every(pattern => pattern.test(responseText))}`,
    ].join(' ')
  )
}

async function sendChatPromptForApprovalJourney(page: Page, prompt: string): Promise<number> {
  const responseCountBefore = await page.getByTestId('agent-response').count()
  const chatInput = page.getByTestId('chat-input')
  await expect(chatInput).toBeEnabled({ timeout: 30_000 })
  await chatInput.fill(prompt)
  await expect(chatInput).toHaveValue(prompt)

  const sendButton = page.getByTestId('send-button')
  await expect(sendButton).toBeEnabled({ timeout: 30_000 })
  await humanClick(sendButton, {
    beforeMs: [400, 900],
    afterMs: [700, 1_200],
  })
  await expect(chatInput).toHaveValue('', { timeout: 10_000 })
  return responseCountBefore
}

async function findVisibleMatchingApprovalButton(
  page: Page,
  expectation: ToolApprovalExpectation
): Promise<Locator | null> {
  const buttons = page.getByTestId('approval-approve-btn')
  const count = await buttons.count()

  for (let index = 0; index < count; index += 1) {
    const approvalButton = buttons.nth(index)
    if (!(await approvalButton.isVisible().catch(() => false))) continue
    const stepper = page.getByTestId('progress-stepper').filter({ has: approvalButton }).first()
    if (!(await stepper.isVisible().catch(() => false))) continue
    const stepperText = ((await stepper.textContent().catch(() => '')) || '').trim()
    const requiredMatches = (expectation.requiredText ?? []).every(pattern =>
      pattern.test(stepperText)
    )
    const forbiddenMatches = (expectation.forbiddenText ?? []).some(pattern =>
      pattern.test(stepperText)
    )
    if (!requiredMatches || forbiddenMatches) continue
    return approvalButton
  }

  return null
}
