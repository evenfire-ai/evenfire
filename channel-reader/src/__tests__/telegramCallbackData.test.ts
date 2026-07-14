import { describe, expect, it } from 'vitest'
import {
  TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA,
  parseTelegramCallbackData,
  telegramWorkflowResultCallbackData,
} from '../telegramCallbackData'

describe('Telegram workflow result callback data', () => {
  it('round trips deterministic workflow result callback data', () => {
    const callbackData = telegramWorkflowResultCallbackData('due-diligence-package')

    expect(callbackData).toBe('wf:r:due-diligence-package')
    expect(parseTelegramCallbackData(callbackData!)).toEqual({
      kind: 'workflowResult',
      workflowName: 'due-diligence-package',
    })
  })

  it('rejects workflow names that cannot be represented safely in Telegram callbacks', () => {
    expect(telegramWorkflowResultCallbackData('Due Diligence')).toBeNull()
    expect(telegramWorkflowResultCallbackData('-due-diligence')).toBeNull()
    expect(telegramWorkflowResultCallbackData('due-diligence-')).toBeNull()
    expect(telegramWorkflowResultCallbackData('due-diligence_' + 'x'.repeat(10))).toBeNull()
    expect(telegramWorkflowResultCallbackData('due-diligence-' + 'x'.repeat(60))).toBeNull()
  })

  it('keeps legacy result callbacks parseable without inventing a workflow name', () => {
    expect(parseTelegramCallbackData(TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA)).toEqual({
      kind: 'workflowResult',
    })
  })
})
