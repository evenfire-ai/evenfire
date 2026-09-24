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

/** Text of the user message that carries tool-result frames. */
const TOOL_RESULT_IMAGE_TEXT = 'Here are the screenshots from the tool results above.'

/**
 * Wire-eligible images of ONE tool result, with their provenance.
 *
 * Deduplication deliberately differs from the UI collection above: the
 * user-facing attachment list collapses identical bytes across iterations,
 * while the model must see every distinct tool call that produced a frame. Two
 * calls returning the same bytes can yield two parts with different sources.
 * The default loop keeps the historical collection view; source binding is
 * explicitly enabled by the transport capabilities of the configured chain.
 */
function collectVisualImageParts(
  result: ToolResult,
  seen: Set<string>,
  legacyRetained: Set<Attachment>,
  preserveSourceIdentity: boolean
): MessageContentPart[] {
  const parts: MessageContentPart[] = []
  for (const attachment of result.attachments ?? []) {
    if (!shouldCollectAttachment(result, attachment)) continue
    if (attachment.kind !== 'image') continue
    const mimeType = attachment.mimeType
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/png') continue
    // Consume membership once: an array can repeat the same attachment object.
    const retained = legacyRetained.delete(attachment)
    if (!retained && !preserveSourceIdentity) continue
    const key = `${result.tool_call_id}\u0000${attachment.id}\u0000${mimeType}\u0000${attachment.dataBase64}`
    // Keep every frame the original collection retained (including distinct
    // filenames/lanes); source dedup must not narrow that legacy view.
    if (seen.has(key) && !retained) continue
    seen.add(key)
    parts.push({
      type: 'image',
      mimeType,
      data: attachment.dataBase64,
      source: { kind: 'tool', attachmentId: attachment.id, toolCallId: result.tool_call_id },
      ...(!retained ? { sourceIdentityOnly: true as const } : {}),
    })
  }
  return parts
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
  collectedAttachments: Attachment[],
  preserveSourceIdentity = false
): void {
  const pendingImages: MessageContentPart[] = []
  const seenVisuals = new Set<string>()
  if (preserveSourceIdentity) {
    for (const message of messages) {
      for (const part of message.contentParts ?? []) {
        if (part.type !== 'image' || part.source?.kind !== 'tool') continue
        seenVisuals.add(
          `${part.source.toolCallId}\u0000${part.source.attachmentId}\u0000${part.mimeType}\u0000${part.data}`
        )
      }
    }
  }
  for (const tr of toolResults) {
    // The UI collection keeps its cross-iteration dedup contract; the visual
    // parts are collected independently so a repeated frame still carries the
    // tool call that produced THIS instance.
    const legacyRetained = new Set(collectToolAttachments([tr], collectedAttachments))
    pendingImages.push(
      ...collectVisualImageParts(tr, seenVisuals, legacyRetained, preserveSourceIdentity)
    )
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
      content: TOOL_RESULT_IMAGE_TEXT,
      // #654 — the parts below came from tool results, not from the user. The
      // adapter withholds them (and says so in `content`) when the model has no
      // affirmative image-input evidence, instead of failing the whole turn.
      imageOrigin: 'tool_result',
      contentParts: [
        {
          type: 'text',
          text: TOOL_RESULT_IMAGE_TEXT,
          ...(pendingImages.every(part => part.sourceIdentityOnly)
            ? { sourceIdentityOnly: true as const }
            : {}),
        },
        ...pendingImages,
      ],
    })
  }
}
