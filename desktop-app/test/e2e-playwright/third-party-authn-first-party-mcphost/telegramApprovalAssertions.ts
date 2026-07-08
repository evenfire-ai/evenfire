import { type Page, expect } from '@playwright/test'
import {
  approveWorkflowFromTelegramClient,
  telegramReplyItems,
  waitForTelegramFinalReplyTextAfter,
  waitForTelegramReplyTextAfter,
  waitForWorkflowApprovalInTelegramClient,
} from './telegramE2eClient'
import {
  approvalStatus,
  providerDecisionEventSignalForApproval,
  workflowRunCountForApproval,
} from './workflowApprovalJourney'

export async function approveAndExpectConsumed(
  page: Page,
  recipeName: string,
  approvalId: string,
  approvalMessage: string,
  runMessage: string,
  options: {
    waitForFinalReply?: string | RegExp
    finalReplyTimeout?: number
    approvalCardTimeout?: number
    consumedTimeout?: number
    runTimeout?: number
  } = {}
): Promise<void> {
  await waitForWorkflowApprovalInTelegramClient(page, recipeName, options.approvalCardTimeout)
  const beforeProviderDecision = await telegramReplyItems(page).count()
  await approveWorkflowFromTelegramClient(page, recipeName)
  await waitForTelegramReplyTextAfter(
    page,
    beforeProviderDecision,
    'Approved. Workflow approval recorded.',
    60_000
  )
  await expect
    .poll(() => approvalStatus(approvalId), {
      timeout: options.consumedTimeout ?? 180_000,
      intervals: [500, 1_000, 2_000],
      message: approvalMessage,
    })
    .toBe('consumed')
  await expect
    .poll(() => workflowRunCountForApproval(approvalId), {
      timeout: options.runTimeout ?? 60_000,
      intervals: [500, 1_000, 2_000],
      message: runMessage,
    })
    .toBe(1)
  expect(providerDecisionEventSignalForApproval(approvalId)).toBe('decided:1')
  if (options.waitForFinalReply) {
    await waitForTelegramFinalReplyTextAfter(
      page,
      beforeProviderDecision,
      options.waitForFinalReply,
      options.finalReplyTimeout
    )
  }
}
