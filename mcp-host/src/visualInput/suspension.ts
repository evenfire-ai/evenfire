import type { ChatMessage, MessageContentPart, PendingApproval, ToolResult } from '../core/types'
import type { GfsImageSource } from './policy'

function reference(source: GfsImageSource) {
  return {
    kind: source.kind,
    drive: source.drive,
    resourceId: source.resourceId,
    gfsUri: source.gfsUri,
    version: source.version,
    name: source.name,
  }
}

function projectMessage(message: ChatMessage): ChatMessage {
  if (!message.contentParts?.some(p => p.type === 'image')) return message
  const parts: MessageContentPart[] = message.contentParts.map(part =>
    part.type === 'image'
      ? {
          type: 'text',
          text: JSON.stringify({
            delivery: 'reference_only',
            reason: 'new_gfs_read_required_after_suspension',
            ...(part.source?.kind === 'gfs' ? { resource: reference(part.source) } : {}),
          }),
        }
      : part
  )
  return {
    ...message,
    content: 'GFS image input was not retained. A new authorized read is required.',
    contentParts: parts,
  }
}

function projectResult(result: ToolResult): ToolResult {
  const removed =
    result.attachments?.filter(a => a.kind === 'image' || a.visualSource?.kind === 'gfs') ?? []
  if (!removed.length) return result
  const attachments = result.attachments?.filter(
    a => a.kind !== 'image' && a.visualSource?.kind !== 'gfs'
  )
  const content = JSON.stringify({
    delivery: 'reference_only',
    reason: 'new_gfs_read_required_after_suspension',
    resources: removed.flatMap(a =>
      a.visualSource?.kind === 'gfs' ? [reference(a.visualSource)] : []
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

/** Preserve approval identity/order while removing every image payload. */
export function projectGfsApproval(approval: PendingApproval): PendingApproval {
  return {
    request_id: approval.request_id,
    tool_name: approval.tool_name,
    tool_call_id: approval.tool_call_id,
    description: approval.description,
    parameters: approval.parameters,
    context_snapshot: approval.context_snapshot.map(projectMessage),
    ...(approval.completed_results
      ? { completed_results: approval.completed_results.map(projectResult) }
      : {}),
    attachments: approval.attachments?.filter(
      a => a.kind !== 'image' && a.visualSource?.kind !== 'gfs'
    ),
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
