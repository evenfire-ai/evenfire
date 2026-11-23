import { describe, expect, it } from 'vitest'
import {
  TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA,
  parseTelegramCallbackData,
  telegramWorkflowResultCallbackData,
} from '../telegramCallbackData'

const TOOL_TOKEN = 'abcdefghijklmnop'

describe('Telegram workflow result callback data', () => {
  it('round trips deterministic workflow result callback data', () => {
    const workflowRunId = '11111111-2222-3333-4444-555555555555'
    const callbackData = telegramWorkflowResultCallbackData(workflowRunId)

    expect(callbackData).toBe(`wf:r:${workflowRunId}`)
    expect(parseTelegramCallbackData(callbackData!)).toEqual({
      kind: 'workflowResult',
      workflowRunId,
    })
  })

  it('rejects malformed workflow run IDs', () => {
    expect(telegramWorkflowResultCallbackData('Due Diligence')).toBeNull()
    expect(telegramWorkflowResultCallbackData('11111111-2222-3333-4444')).toBeNull()
  })

  it('keeps legacy result callbacks parseable without inventing a workflow run', () => {
    expect(parseTelegramCallbackData(TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA)).toEqual({
      kind: 'workflowResult',
    })
  })

  it('keeps previously delivered recipe-name callbacks working', () => {
    expect(parseTelegramCallbackData('wf:r:due-diligence-package')).toEqual({
      kind: 'workflowResult',
      workflowName: 'due-diligence-package',
    })
  })
})

describe('Telegram tool approval callback data', () => {
  it.each([
    ['a', 'approve'],
    ['l', 'approveAlways'],
    ['c', 'command'],
    ['s', 'shell'],
    ['d', 'deny'],
  ] as const)('maps tool:%s to %s and stays within 64 bytes', (code, decision) => {
    const callbackData = `tool:${code}:${TOOL_TOKEN}`
    expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseTelegramCallbackData(callbackData)).toEqual({
      kind: 'toolApprovalDecision',
      decision,
      actionToken: TOOL_TOKEN,
    })
  })

  it('returns null for an unknown tool code instead of deny', () => {
    expect(parseTelegramCallbackData(`tool:q:${TOOL_TOKEN}`)).toBeNull()
    expect(parseTelegramCallbackData(`tool:x:${TOOL_TOKEN}`)).toBeNull()
    expect(parseTelegramCallbackData('tool:c:short')).toBeNull()
  })
})
