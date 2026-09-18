import { isImageAttachmentMime } from '../../llm/imageInput'
import {
  isInternalGeneratedArtifactAttachment,
  isInternalGeneratedArtifactSourceTool,
} from '../tools/generatedArtifactAttachments'
import type { Attachment, ChatMessage, MessageContentPart, ToolResult } from '../types'

function shouldCollectAttachment(result: ToolResult, attachment: Attachment): boolean {
  if (attachment.kind === 'image') return true
  if (attachment.kind !== 'file') return false
  if (attachment.sourceTool === 'workflow_result') return result.name === 'workflow_result'
  if (!isInternalGeneratedArtifactAttachment(attachment)) return false
  return result.name === attachment.sourceTool && isInternalGeneratedArtifactSourceTool(result.name)
}

function attachmentDedupKey(attachment: Attachment): string {
  return [
    attachment.kind,
    attachment.lane ?? '',
    attachment.sourceTool ?? '',
    attachment.filename ?? '',
    attachment.mimeType,
    attachment.artifactFormat ?? '',
    attachment.producer ?? '',
    attachment.encoding,
    attachment.dataBase64,
  ].join('\u0000')
}

function appendCollectedAttachment(
  collectedAttachments: Attachment[],
  attachment: Attachment
): boolean {
  const key = attachmentDedupKey(attachment)
  if (collectedAttachments.some(existing => attachmentDedupKey(existing) === key)) return false
  collectedAttachments.push(attachment)
  return true
}

/** Reuse the same provenance and deduplication rules for interrupted work. */
export function collectToolAttachments(
  results: ToolResult[],
  collected: Attachment[]
): Attachment[] {
  const added: Attachment[] = []
  for (const result of results) {
    for (const attachment of result.attachments ?? []) {
      if (
        shouldCollectAttachment(result, attachment) &&
        appendCollectedAttachment(collected, attachment)
      )
        added.push(attachment)
    }
  }
  return added
}

export function mergeCollectedAttachments(
  collected: Attachment[],
  attachments: Attachment[]
): void {
  for (const attachment of attachments) appendCollectedAttachment(collected, attachment)
}

export function appendToolResults(
  messages: ChatMessage[],
  toolResults: ToolResult[],
  collectedAttachments: Attachment[]
): void {
  const pendingImages: MessageContentPart[] = []
  for (const tr of toolResults) {
    const trustedAttachments = collectToolAttachments([tr], collectedAttachments)
    if (trustedAttachments.length) {
      for (const att of trustedAttachments) {
        if (att.kind !== 'image') continue
        if (!isImageAttachmentMime(att.mimeType)) continue
        pendingImages.push({
          type: 'image',
          mimeType: att.mimeType,
          data: att.dataBase64,
        })
      }
    }
    messages.push({
      role: 'tool',
      content: tr.content,
      tool_call_id: tr.tool_call_id,
      name: tr.name,
      // T1.5 — propagate the lateral field so the IronClaw snapshot taken at
      // suspend time naturally carries it (P0-002 Opción D).
      spillover_ref: tr.spillover_ref,
    })
  }

  if (pendingImages.length > 0) {
    messages.push({
      role: 'user',
      content: 'Here are the screenshots from the tool results above.',
      contentParts: [
        { type: 'text', text: 'Here are the screenshots from the tool results above.' },
        ...pendingImages,
      ],
    })
  }
}
