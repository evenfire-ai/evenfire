const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WORKFLOW_NAME_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

const APPROVAL_CALLBACK_RE = /^wf:([ad]):([0-9a-f-]{36})$/i
const RESULT_CALLBACK_RE = /^wf:r:([a-z0-9][a-z0-9.-]*[a-z0-9])$/i
export const TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA = 'wf:r'

export type TelegramCallbackAction =
  | {
      kind: 'workflowApprovalDecision'
      decision: 'approve' | 'deny'
      approvalRequestId: string
    }
  | {
      kind: 'workflowResult'
      workflowName?: string
    }

function ensureTelegramCallbackDataSize(value: string): string {
  if (Buffer.byteLength(value, 'utf8') > 64) {
    throw new Error('telegram_callback_data_too_large')
  }
  return value
}

export function telegramWorkflowApprovalCallbackData(
  decision: 'approve' | 'deny',
  approvalRequestId: string
): string {
  if (!UUID_RE.test(approvalRequestId)) {
    throw new Error('invalid_workflow_approval_request_id')
  }
  return ensureTelegramCallbackDataSize(
    'wf:' + (decision === 'approve' ? 'a' : 'd') + ':' + approvalRequestId
  )
}

export function parseTelegramCallbackData(
  value: string | null | undefined
): TelegramCallbackAction | null {
  const data = value?.trim()
  if (!data) return null
  if (data === TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA) {
    return { kind: 'workflowResult' }
  }
  const resultMatch = RESULT_CALLBACK_RE.exec(data)
  if (resultMatch) {
    return { kind: 'workflowResult', workflowName: resultMatch[1] }
  }

  const match = APPROVAL_CALLBACK_RE.exec(data)
  if (!match) return null
  const approvalRequestId = match[2]
  if (!UUID_RE.test(approvalRequestId)) return null
  return {
    kind: 'workflowApprovalDecision',
    decision: match[1].toLowerCase() === 'a' ? 'approve' : 'deny',
    approvalRequestId,
  }
}

export function telegramWorkflowResultCallbackData(workflowName: string): string | null {
  const normalized = workflowName.trim()
  if (!WORKFLOW_NAME_RE.test(normalized)) return null
  const value = `wf:r:${normalized}`
  return Buffer.byteLength(value, 'utf8') <= 64 ? value : null
}
