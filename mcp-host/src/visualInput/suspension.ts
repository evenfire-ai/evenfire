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
  if (!message.contentParts?.some(p => p.type === 'image' && p.source?.kind === 'gfs'))
    return message
  const parts: MessageContentPart[] = message.contentParts.map(part =>
    part.type === 'image' && part.source?.kind === 'gfs'
      ? {
          type: 'text',
          text: JSON.stringify({
            delivery: 'reference_only',
            reason: 'new_gfs_read_required_after_suspension',
            resource: reference(part.source),
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
  const removed = result.attachments?.filter(a => a.visualSource?.kind === 'gfs') ?? []
  if (!removed.length) return result
  const attachments = result.attachments?.filter(a => a.visualSource?.kind !== 'gfs')
  const content = JSON.stringify({
    delivery: 'reference_only',
    reason: 'new_gfs_read_required_after_suspension',
    resources: removed.map(a => reference(a.visualSource!)),
  })
  return {
    ...result,
    content,
    rawContent: content,
    spillover_ref: undefined,
    attachments: attachments?.length ? attachments : undefined,
  }
}

/** Preserve approval identity/order while removing only newly introduced GFS payloads. */
export function projectGfsApproval(approval: PendingApproval): PendingApproval {
  return {
    ...approval,
    context_snapshot: approval.context_snapshot.map(projectMessage),
    completed_results: approval.completed_results?.map(projectResult),
    attachments: approval.attachments?.filter(a => a.visualSource?.kind !== 'gfs'),
  }
}
