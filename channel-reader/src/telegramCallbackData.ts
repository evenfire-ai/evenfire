const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const APPROVAL_CALLBACK_RE = /^wf:([ad]):([0-9a-f-]{36})$/i
const RESULT_CALLBACK_RE = /^wf:r:([0-9a-f-]{36})$/i
const LEGACY_RESULT_CALLBACK_RE = /^wf:r:([a-z0-9][a-z0-9.-]*[a-z0-9])$/i
const TOOL_APPROVAL_CALLBACK_RE = /^tool:([ald]):([A-Za-z0-9_-]{16})$/
export const TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA = 'wf:r'

export type TelegramCallbackAction =
  | {
      kind: 'toolApprovalDecision'
      decision: 'approve' | 'approveAlways' | 'deny'
      actionToken: string
    }
  | {
      kind: 'workflowApprovalDecision'
      decision: 'approve' | 'deny'
      approvalRequestId: string
    }
  | {
      kind: 'workflowResult'
      workflowRunId?: string
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
  const toolApprovalMatch = TOOL_APPROVAL_CALLBACK_RE.exec(data)
  if (toolApprovalMatch) {
    return {
      kind: 'toolApprovalDecision',
      decision:
        toolApprovalMatch[1] === 'a'
          ? 'approve'
          : toolApprovalMatch[1] === 'l'
            ? 'approveAlways'
            : 'deny',
      actionToken: toolApprovalMatch[2],
    }
  }
  if (data === TELEGRAM_WORKFLOW_RESULT_CALLBACK_DATA) {
    return { kind: 'workflowResult' }
  }
  const resultMatch = RESULT_CALLBACK_RE.exec(data)
  if (resultMatch && UUID_RE.test(resultMatch[1])) {
    return { kind: 'workflowResult', workflowRunId: resultMatch[1] }
  }
  const legacyResultMatch = LEGACY_RESULT_CALLBACK_RE.exec(data)
  if (legacyResultMatch) {
    return { kind: 'workflowResult', workflowName: legacyResultMatch[1] }
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

export function telegramWorkflowResultCallbackData(workflowRunId: string): string | null {
  const normalized = workflowRunId.trim()
  if (!UUID_RE.test(normalized)) return null
  const value = `wf:r:${normalized}`
  return Buffer.byteLength(value, 'utf8') <= 64 ? value : null
}
