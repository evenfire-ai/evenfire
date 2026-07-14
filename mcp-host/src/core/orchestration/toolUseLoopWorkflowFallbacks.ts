import type { ToolResult } from '../types'
import { summarizeWorkflowListItemInputs } from './toolUseLoopWorkflowInputSummary'
import {
  buildWorkflowTriggerFallbackResponse,
  buildWorkflowTriggerNonRunFallbackResponse,
} from './toolUseLoopWorkflowTriggerFallbacks'

const WORKFLOW_RUN_SUMMARY_FALLBACK_KEYS = [
  'phase',
  'triggeredAt',
  'startedAt',
  'completedAt',
  'message',
]

export function buildReadOnlyWorkflowToolFallbackResponse(
  toolResults: ToolResult[] | null
): string | null {
  const resultTool = toolResults?.find(
    result => result.name === 'workflow_result' && result.is_error !== true
  )
  if (resultTool) return buildWorkflowResultFallbackResponse(resultTool)

  const listTool = toolResults?.find(
    result => result.name === 'workflow_list' && result.is_error !== true
  )
  if (!listTool) return null

  // T1.5 interaction — when a `workflow_*` read output exceeds the spillover
  // threshold, `executeSingleTool` swaps `content` for a `SpilloverSummary`
  // JSON (no `.items`/business fields). The untouched blob lives on
  // `rawContent`, so parse that first; fall back to `content` for the
  // non-spilled / legacy path. Applied at every parse site below.
  const parsed = parseToolJsonPayload(listTool.rawContent ?? listTool.content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const itemsValue = (parsed as Record<string, unknown>).items
  const items = Array.isArray(itemsValue)
    ? itemsValue.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && !Array.isArray(item)
      )
    : []

  if (items.length === 0) {
    return 'I did not find workflow recipes you can trigger from the current conversation grants.'
  }

  const lines = ['Workflow recipes you can trigger:', '']
  for (const item of items) {
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : null
    if (!name) continue
    lines.push(`- ${name}: ${summarizeWorkflowListItemInputs(item)}`)
  }

  return lines.length > 2 ? lines.join('\n') : null
}

export function buildWorkflowToolSuccessFallbackResponse(
  toolResults: ToolResult[] | null
): string | null {
  const triggerTool = toolResults?.find(
    result => result.name === 'workflow_trigger' && result.is_error !== true
  )
  const triggerFallback = triggerTool ? buildWorkflowTriggerFallbackResponse(triggerTool) : null
  if (triggerFallback) return triggerFallback

  const resultTool = toolResults?.find(
    result => result.name === 'workflow_result' && result.is_error !== true
  )
  const resultFallback = resultTool ? buildWorkflowResultFallbackResponse(resultTool) : null
  if (resultFallback) return resultFallback

  const statusTool = toolResults?.find(
    result => result.name === 'workflow_status' && result.is_error !== true
  )
  const statusFallback = statusTool ? buildWorkflowStatusFallbackResponse(statusTool) : null
  if (statusFallback) return statusFallback

  const healthTool = toolResults?.find(
    result => result.name === 'workflow_health' && result.is_error !== true
  )
  const healthFallback = healthTool ? buildWorkflowHealthFallbackResponse(healthTool) : null
  if (healthFallback) return healthFallback

  return buildReadOnlyWorkflowToolFallbackResponse(toolResults)
}

export function buildWorkflowListFallbackWhenResponseOmitsNames(
  responseContent: string,
  toolResults: ToolResult[] | null
): string | null {
  const listTool = toolResults?.find(
    result => result.name === 'workflow_list' && result.is_error !== true
  )
  if (!listTool) return null

  const workflowItems = workflowListItemsFromToolResult(listTool)
  const workflowNames = workflowItems.flatMap(item => workflowListItemName(item))
  if (workflowNames.length === 0) return null

  const normalizedContent = responseContent.toLocaleLowerCase('en-US')
  if (workflowNames.some(name => !normalizedContent.includes(name.toLocaleLowerCase('en-US')))) {
    return buildReadOnlyWorkflowToolFallbackResponse([listTool])
  }

  if (
    workflowItems.some(item =>
      workflowListItemInputNames(item).some(
        name => !normalizedContent.includes(name.toLocaleLowerCase('en-US'))
      )
    )
  ) {
    return buildReadOnlyWorkflowToolFallbackResponse([listTool])
  }

  return null
}

export function isWorkflowSuccessFallbackToolName(name: string): boolean {
  return (
    name === 'workflow_list' ||
    name === 'workflow_result' ||
    name === 'workflow_status' ||
    name === 'workflow_health' ||
    name === 'workflow_trigger'
  )
}

export function buildWorkflowToolFailureResponse(toolResults: ToolResult[]): string | null {
  if (!toolResults.every(result => isWorkflowToolName(result.name))) return null

  const failed = toolResults.find(
    result => result.is_error === true && isWorkflowToolName(result.name)
  )
  if (!failed) return null

  const successfulTrigger = toolResults.find(
    result => result.name === 'workflow_trigger' && result.is_error !== true
  )
  const triggerResponse = successfulTrigger
    ? buildWorkflowTriggerFallbackResponse(successfulTrigger)
    : null
  if (triggerResponse) return triggerResponse

  switch (failed.name) {
    case 'workflow_list':
      return [
        'I could not retrieve the workflow recipes available to this conversation because the workflow tool failed.',
        'I will not infer or invent workflow names. Please retry after the workflow connection is refreshed.',
      ].join(' ')
    case 'workflow_result':
      return [
        'I could not retrieve the workflow result artifact because the workflow tool failed.',
        'I will not infer workflow outputs without the actual run result.',
      ].join(' ')
    case 'workflow_status':
    case 'workflow_health':
      return [
        'I could not read the workflow state because the workflow tool failed.',
        'I will not infer status or health without the actual workflow response.',
      ].join(' ')
    case 'workflow_trigger':
      return [
        'I could not trigger the workflow because the workflow tool failed.',
        'No workflow run was confirmed from this chat request.',
      ].join(' ')
    default:
      return 'I could not complete the workflow request because the workflow tool failed.'
  }
}

function buildWorkflowResultFallbackResponse(toolResult: ToolResult): string | null {
  const record = parseToolResultRecord(toolResult)
  if (!record) return null
  const workflowName =
    typeof record.workflowName === 'string' && record.workflowName.trim()
      ? record.workflowName.trim()
      : null
  const result = record.result
  const resultLines = summarizeWorkflowResultValue(result)
  if (resultLines.length === 0) return null

  return [
    workflowName ? `Workflow result for ${workflowName}:` : 'Workflow result:',
    '',
    ...resultLines,
  ].join('\n')
}

function buildWorkflowStatusFallbackResponse(toolResult: ToolResult): string | null {
  const record = parseToolResultRecord(toolResult)
  if (!record) return null
  const workflowName = workflowNameFromFallbackRecord(record)
  if (!workflowName) return null

  const lines = [`Workflow status for ${workflowName}:`]
  appendScalarLine(lines, 'Phase', record.phase)
  appendScalarLine(lines, 'Workflow phase', record.workflowPhase)
  appendRunSummaryLines(lines, 'Latest run', record.latestRun)
  return lines.length > 1 ? lines.join('\n') : null
}

function buildWorkflowHealthFallbackResponse(toolResult: ToolResult): string | null {
  const record = parseToolResultRecord(toolResult)
  if (!record) return null
  const workflowName = workflowNameFromFallbackRecord(record)
  if (!workflowName) return null

  const lines = [`Workflow health for ${workflowName}:`]
  appendScalarLine(lines, 'Phase', record.phase)
  appendScalarLine(lines, 'Workflow phase', record.workflowPhase)
  appendScalarLine(lines, 'Active runs', record.activeRuns)
  appendRunSummaryLines(lines, 'Last run', record.lastRun)
  return lines.length > 1 ? lines.join('\n') : null
}

function workflowListNamesFromToolResult(toolResult: ToolResult): string[] {
  return workflowListItemsFromToolResult(toolResult).flatMap(item => workflowListItemName(item))
}

function workflowListItemsFromToolResult(toolResult: ToolResult): Array<Record<string, unknown>> {
  const parsed = parseToolJsonPayload(toolResult.rawContent ?? toolResult.content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  const itemsValue = (parsed as Record<string, unknown>).items
  if (!Array.isArray(itemsValue)) return []
  return itemsValue.filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' && !Array.isArray(item)
  )
}

function workflowListItemName(item: Record<string, unknown>): string[] {
  const name = typeof item.name === 'string' ? item.name.trim() : ''
  return name ? [name] : []
}

function workflowListItemInputNames(item: Record<string, unknown>): string[] {
  const inputs = Array.isArray(item.inputs) ? item.inputs : []
  return inputs.flatMap(input => {
    const record =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {}
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    return name ? [name] : []
  })
}

function workflowNameFromFallbackRecord(record: Record<string, unknown>): string {
  const workflowName =
    typeof record.workflowName === 'string' && record.workflowName.trim()
      ? record.workflowName.trim()
      : typeof record.name === 'string' && record.name.trim()
        ? record.name.trim()
        : ''
  return workflowName
}

function appendScalarLine(lines: string[], label: string, value: unknown): void {
  if (value === null || value === undefined) return
  if (isWorkflowResultScalar(value)) {
    lines.push(`- ${label}: ${formatWorkflowResultPrimitive(value)}`)
  }
}

function appendRunSummaryLines(lines: string[], label: string, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const summary: string[] = []
  for (const key of WORKFLOW_RUN_SUMMARY_FALLBACK_KEYS) {
    const rawValue = record[key]
    if (rawValue === null || rawValue === undefined) continue
    if (isWorkflowResultScalar(rawValue)) {
      summary.push(`${key}: ${formatWorkflowResultPrimitive(rawValue)}`)
    }
  }
  if (summary.length > 0) lines.push(`- ${label}: ${summary.join(', ')}`)
}

function summarizeWorkflowResultValue(value: unknown): string[] {
  const lines: string[] = []
  const omittedNestedFields: string[] = []
  if (!value || typeof value !== 'object' || Array.isArray(value)) return lines

  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (isWorkflowResultScalar(rawValue)) {
      lines.push(`- ${key}: ${formatWorkflowResultPrimitive(rawValue)}`)
      continue
    }
    omittedNestedFields.push(key)
  }

  if (omittedNestedFields.length > 0) {
    lines.push(
      `- Nested artifact fields omitted from this chat summary: ${omittedNestedFields.join(', ')}. They are available in the workflow result artifact.`
    )
  }
  return lines
}

function isWorkflowResultScalar(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  )
}

function formatWorkflowResultPrimitive(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return String(value)
  return ''
}

function isWorkflowToolName(name: string): boolean {
  return (
    name === 'workflow_list' ||
    name === 'workflow_status' ||
    name === 'workflow_health' ||
    name === 'workflow_result' ||
    name === 'workflow_trigger'
  )
}

function parseToolResultRecord(toolResult: ToolResult): Record<string, unknown> | null {
  const parsed = parseToolJsonPayload(toolResult.rawContent ?? toolResult.content)
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
