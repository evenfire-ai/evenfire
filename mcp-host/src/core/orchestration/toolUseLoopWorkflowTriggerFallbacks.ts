import type { ToolResult } from '../types'

const NON_RUN_WORKFLOW_TRIGGER_STATUSES = new Set([
  'needs_clarification',
  'not_available',
  'workflow_not_found',
])

export function buildWorkflowTriggerFallbackResponse(toolResult: ToolResult): string | null {
  const nonRunResponse = buildWorkflowTriggerNonRunFallbackResponse(toolResult)
  if (nonRunResponse) return nonRunResponse

  const record = parseToolResultRecord(toolResult)
  if (!record) return null
  const workflowName =
    typeof record.workflowName === 'string' && record.workflowName.trim()
      ? record.workflowName.trim()
      : typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : ''
  if (!workflowName) return null

  const target =
    record.target && typeof record.target === 'object' && !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : {}
  const targetLabel =
    typeof target.label === 'string' && target.label.trim() ? target.label.trim() : ''
  const phase = typeof record.phase === 'string' && record.phase.trim() ? record.phase.trim() : ''
  const message =
    typeof record.message === 'string' && record.message.trim() ? record.message.trim() : ''

  const lines = [
    `Workflow ${workflowName} was approved and triggered${targetLabel ? ` for ${targetLabel}` : ''}.`,
  ]
  if (phase) lines.push(`Current phase: ${phase}.`)
  if (message) lines.push(message.endsWith('.') ? message : `${message}.`)
  return lines.join(' ')
}

export function buildWorkflowTriggerNonRunFallbackResponse(toolResult: ToolResult): string | null {
  const record = parseToolResultRecord(toolResult)
  if (!record) return null
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  if (!NON_RUN_WORKFLOW_TRIGGER_STATUSES.has(status)) return null
  const message =
    typeof record.message === 'string' && record.message.trim() ? record.message.trim() : ''
  return message || null
}

export function buildWorkflowTriggerImmediateFallbackResponse(
  toolResults: ToolResult[]
): string | null {
  const triggerTool = toolResults.find(isWorkflowTriggerNotFoundToolResult)
  if (!triggerTool) return null

  const successfulTrigger = toolResults.find(isWorkflowTriggerPositiveToolResult)
  if (successfulTrigger) return buildWorkflowTriggerFallbackResponse(successfulTrigger)

  return buildWorkflowTriggerNonRunFallbackResponse(triggerTool)
}

export function isWorkflowTriggerNotFoundToolResult(toolResult: ToolResult): boolean {
  if (toolResult.name !== 'workflow_trigger' || toolResult.is_error === true) return false

  const record = parseToolResultRecord(toolResult)
  if (!record) return false
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  return status === 'workflow_not_found'
}

function isWorkflowTriggerPositiveToolResult(toolResult: ToolResult): boolean {
  return (
    toolResult.name === 'workflow_trigger' &&
    toolResult.is_error !== true &&
    !buildWorkflowTriggerNonRunFallbackResponse(toolResult) &&
    Boolean(buildWorkflowTriggerFallbackResponse(toolResult))
  )
}

export function buildWorkflowTriggerNonRunFallbackWhenResponseOmitsClarification(
  responseContent: string,
  toolResults: ToolResult[] | null
): string | null {
  const triggerTool = toolResults?.find(
    result => result.name === 'workflow_trigger' && result.is_error !== true
  )
  if (!triggerTool) return null

  const fallback = buildWorkflowTriggerNonRunFallbackResponse(triggerTool)
  if (!fallback) return null

  const record = parseToolResultRecord(triggerTool)
  if (!record) return null
  const status = typeof record.status === 'string' ? record.status.trim() : ''
  if (!NON_RUN_WORKFLOW_TRIGGER_STATUSES.has(status)) return null

  const normalizedContent = responseContent.toLocaleLowerCase('en-US')
  const workflowName =
    typeof record.workflowName === 'string' && record.workflowName.trim()
      ? record.workflowName.trim()
      : ''
  if (workflowName && !normalizedContent.includes(workflowName.toLocaleLowerCase('en-US'))) {
    return fallback
  }

  if (status === 'needs_clarification') {
    const targets = Array.isArray(record.targets) ? record.targets : []
    const missingTarget = targets.some(target => {
      const item =
        target && typeof target === 'object' && !Array.isArray(target)
          ? (target as Record<string, unknown>)
          : {}
      const label = typeof item.label === 'string' ? item.label.trim() : ''
      return label && !normalizedContent.includes(label.toLocaleLowerCase('en-US'))
    })
    if (missingTarget || !/\b(choose|select|which|target|label)\b/i.test(responseContent)) {
      return fallback
    }
  }

  if (
    (status === 'not_available' || status === 'workflow_not_found') &&
    !/\b(not available|cannot run|can't run|no access|not authorized|not permitted|not found)\b/i.test(
      responseContent
    )
  ) {
    return fallback
  }

  return null
}

function parseToolResultRecord(toolResult: ToolResult): Record<string, unknown> | null {
  const parsed = parseToolJsonPayload(toolResult.content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function parseToolJsonPayload(content: string): unknown | null {
  const trimmed = content.trim()
  const xmlMatch = trimmed.match(/<tool_output\b[^>]*>\s*([\s\S]*?)\s*<\/tool_output>/i)
  const jsonText = (xmlMatch?.[1] ?? trimmed).replace(/&lt;\/tool_output&gt;/gi, '</tool_output>')
  try {
    return JSON.parse(jsonText)
  } catch {
    return null
  }
}
