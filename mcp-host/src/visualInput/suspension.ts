import type { PendingApproval, ToolResult } from '../core/types'
import { gfsImageParts, gfsReference, projectGfsMessages } from './messageProjection'

function projectResult(result: ToolResult): ToolResult {
  const removed = result.attachments?.filter(a => a.visualSource?.kind === 'gfs') ?? []
  if (!removed.length) return result
  const attachments = result.attachments?.filter(a => a.visualSource?.kind !== 'gfs')
  const content = JSON.stringify({
    delivery: 'reference_only',
    reason: 'new_gfs_read_required_after_suspension',
    resources: removed.flatMap(a =>
      a.visualSource?.kind === 'gfs' ? [gfsReference(a.visualSource)] : []
    ),
  })
  return {
    tool_call_id: result.tool_call_id,
    name: result.name,
    content,
    rawContent: content,
    is_error: result.is_error,
    ...(result.metadata ? { metadata: result.metadata } : {}),
    attachments: attachments?.length ? attachments : undefined,
  }
}

/** Preserve approval identity/order while removing transient GFS image payloads. */
export function projectGfsApproval(approval: PendingApproval): PendingApproval {
  const selected = new Set(gfsImageParts(approval.context_snapshot))
  return {
    request_id: approval.request_id,
    tool_name: approval.tool_name,
    tool_call_id: approval.tool_call_id,
    description: approval.description,
    parameters: approval.parameters,
    context_snapshot: projectGfsMessages(
      approval.context_snapshot,
      selected,
      'new_gfs_read_required_after_suspension'
    ),
    ...(approval.completed_results
      ? { completed_results: approval.completed_results.map(projectResult) }
      : {}),
    attachments: approval.attachments?.filter(a => a.visualSource?.kind !== 'gfs'),
    ...(approval.task_budget ? { task_budget: approval.task_budget } : {}),
    ...(approval.legacy_budget ? { legacy_budget: approval.legacy_budget } : {}),
    ...(approval.replaces_request_id ? { replaces_request_id: approval.replaces_request_id } : {}),
    ...(approval.tool_kind ? { tool_kind: approval.tool_kind } : {}),
    ...(approval.tool_source_ref !== undefined
      ? { tool_source_ref: approval.tool_source_ref }
      : {}),
    ...(approval.intent_summary ? { intent_summary: approval.intent_summary } : {}),
    ...(approval.traceContext !== undefined ? { traceContext: approval.traceContext } : {}),
    ...(approval.reason ? { reason: approval.reason } : {}),
    ...(approval.mcpServerName ? { mcpServerName: approval.mcpServerName } : {}),
  }
}
