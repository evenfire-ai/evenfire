/**
 * X9 / X10 — Channel attachment hydration, deterministic attachment-only
 * confirmation copy, `<turn-context>` projection, and SHA-256-verified
 * per-read byte loader for native tools (`clerum__attachment_read`,
 * `clerum__document_read`, `clerum__gfs_save_attachment`).
 */
import { type FileReferenceV1, parseFileReferenceV1 } from '@clerum/gfs-interaction-policy'
import type { ConversationStore } from '../core/conversation/conversationStore'
import type {
  TurnContextAttachedFile,
  TurnContextAttachedImage,
} from '../core/orchestration/turnContext'
import { DEFAULT_DOCUMENT_READ_LIMITS } from '../core/tools/documentRead/types'
import type { Attachment } from '../core/types'
import type { RetainedChannelAttachmentRow } from '../db/worker/protocol'
import { logger } from '../logger'
import type { ChannelAttachmentIngestError } from '../server/types'
import { type ChannelAttachmentStore, ChannelAttachmentStoreError } from './channelAttachmentStore'
import { PrivateStoreUntrustedError } from './gfsStorePrivateFiles'

export interface HydratedChannelAttachment {
  row: RetainedChannelAttachmentRow
  fileReference: FileReferenceV1
  isCurrentTurn: boolean
  isImage: boolean
  documentReadOverLimit: boolean
}

export type RetainedAttachmentLoadResult =
  | { ok: true; bytes: Buffer; fileReference: FileReferenceV1 }
  | {
      ok: false
      code: 'attachment_not_found' | 'attachment_integrity_failed' | 'attachment_unavailable'
    }

export type RetainedAttachmentByteLoader = (
  attachmentId: string
) => Promise<RetainedAttachmentLoadResult>

export interface ChannelAttachmentToolContext {
  attachments: readonly Attachment[]
  loadBytes: RetainedAttachmentByteLoader
}

/**
 * Fixed deterministic non-empty user marker persisted as `turn.user_input` for
 * attachment-only turns (`X9`, `R46`). Count only — never raw untrusted filenames.
 */
export function attachmentOnlyUserInputMarker(attachmentCount: number): string {
  const safeCount =
    Number.isSafeInteger(attachmentCount) && attachmentCount >= 0 ? attachmentCount : 0
  return `[User attached ${safeCount} file(s)]`
}

/**
 * Hydrate all active retained `conversation_attachments` rows for
 * `(sessionKey, linkedUserId)` from the durable store (`X10`, `R34`, `R37`, `R87`).
 */
export async function hydrateActiveChannelAttachments(params: {
  conversationStore: ConversationStore
  sessionKey: string
  linkedUserId: string
  currentTurnAttachmentIds?: readonly string[]
  nowEpoch?: number
}): Promise<HydratedChannelAttachment[]> {
  if (!params.conversationStore.listActiveChannelAttachments) return []
  const rows = await params.conversationStore.listActiveChannelAttachments(
    params.sessionKey,
    params.linkedUserId,
    params.nowEpoch ?? Date.now() / 1000
  )
  const currentSet = new Set(params.currentTurnAttachmentIds ?? [])
  const hydrated: HydratedChannelAttachment[] = []
  for (const row of rows) {
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(row.file_reference_json)
    } catch {
      logger.warn(
        { component: 'ChannelAttachmentHydration', attachmentId: row.attachment_id },
        'Skipping retained channel attachment with unparseable file_reference_json'
      )
      continue
    }
    const parsedRef = parseFileReferenceV1(parsedJson)
    if (!parsedRef.ok) {
      logger.warn(
        { component: 'ChannelAttachmentHydration', attachmentId: row.attachment_id },
        'Skipping retained channel attachment with invalid FileReferenceV1'
      )
      continue
    }
    const fileReference = parsedRef.value
    const isImage = fileReference.class === 'jpeg' || fileReference.class === 'png'
    const documentReadOverLimit =
      (fileReference.reader === 'pdf' || fileReference.reader === 'xlsx') &&
      row.byte_length > DEFAULT_DOCUMENT_READ_LIMITS.maxSourceBytes
    hydrated.push({
      row,
      fileReference,
      isCurrentTurn: currentSet.has(row.attachment_id),
      isImage,
      documentReadOverLimit,
    })
  }
  return hydrated
}

/**
 * Synthesize metadata-only `Attachment` descriptors (with `dataBase64` absent)
 * for native tool lookup (`clerum__attachment_read`, `clerum__document_read`,
 * `clerum__gfs_save_attachment`). Actual bytes are loaded & SHA-256-verified
 * on demand per read via `createRetainedAttachmentByteLoader`.
 */
export function metadataAttachmentsFromHydrated(
  hydrated: readonly HydratedChannelAttachment[]
): Attachment[] {
  return hydrated.map(({ row, fileReference, isImage }) => {
    const attachment: Attachment = {
      id: row.attachment_id,
      kind: isImage ? 'image' : 'file',
      mimeType: fileReference.detectedMediaType,
      encoding: 'base64',
      // Deliberately absent so bytes never travel inline or freeze in pending_approvals.
      dataBase64: undefined as unknown as string,
      filename: fileReference.name,
      sizeBytes: row.byte_length,
      ...(row.width !== null ? { width: row.width } : {}),
      ...(row.height !== null ? { height: row.height } : {}),
      detectedMediaType: fileReference.detectedMediaType,
      digest: fileReference.digest,
      fileReference,
    }
    return attachment
  })
}

/**
 * Build a per-read SHA-256-verified byte loader bound to `(sessionKey, linkedUserId)`.
 * Re-verifies SQLite ownership + TTL/active-session/pending_approval pin AND
 * `openPrivateStoreObject` + SHA-256 on every call (`R40`, `R41`, `R87`, `SF5`).
 */
export function createRetainedAttachmentByteLoader(params: {
  channelAttachmentStore: ChannelAttachmentStore
  conversationStore: ConversationStore
  sessionKey: string
  linkedUserId: string
}): RetainedAttachmentByteLoader {
  return async (attachmentId: string): Promise<RetainedAttachmentLoadResult> => {
    if (
      !params.conversationStore.getChannelAttachmentForOwner ||
      !params.channelAttachmentStore.isAvailable()
    ) {
      return { ok: false, code: 'attachment_unavailable' }
    }
    try {
      const { record, bytes } = await params.channelAttachmentStore.readForOwner(
        {
          getChannelAttachmentForOwner: (id, key, userId, nowEpoch) =>
            params.conversationStore.getChannelAttachmentForOwner!(id, key, userId, nowEpoch),
        },
        {
          attachmentId,
          sessionKey: params.sessionKey,
          linkedUserId: params.linkedUserId,
        }
      )
      const parsedRef = parseFileReferenceV1(JSON.parse(record.file_reference_json))
      if (!parsedRef.ok) {
        return { ok: false, code: 'attachment_integrity_failed' }
      }
      return { ok: true, bytes, fileReference: parsedRef.value }
    } catch (err) {
      if (err instanceof PrivateStoreUntrustedError) {
        logger.warn(
          { component: 'ChannelAttachmentHydration', attachmentId },
          'Channel attachment failed private store trust check'
        )
        return { ok: false, code: 'attachment_integrity_failed' }
      }
      if (err instanceof ChannelAttachmentStoreError) {
        if (err.code === 'attachment_not_found') {
          return { ok: false, code: 'attachment_not_found' }
        }
        if (err.code === 'attachment_integrity_failed') {
          logger.warn(
            { component: 'ChannelAttachmentHydration', attachmentId },
            'Channel attachment failed SHA-256 integrity verification'
          )
          return { ok: false, code: 'attachment_integrity_failed' }
        }
        return { ok: false, code: 'attachment_unavailable' }
      }
      logger.warn(
        { component: 'ChannelAttachmentHydration', attachmentId, err },
        'Unexpected failure loading retained channel attachment'
      )
      return { ok: false, code: 'attachment_unavailable' }
    }
  }
}

export function turnContextFilesFromHydrated(
  hydrated: readonly HydratedChannelAttachment[]
): TurnContextAttachedFile[] {
  const files: TurnContextAttachedFile[] = []
  for (const item of hydrated) {
    if (item.isImage) continue
    const ref = item.fileReference
    files.push({
      attachmentId: item.row.attachment_id,
      name: ref.name,
      class: ref.class,
      byteLength: ref.byteLength,
      reader: ref.reader,
      mismatch: ref.mismatch,
      declaredMediaType: ref.declaredMediaType,
      detectedMediaType: ref.detectedMediaType,
      retained: !item.isCurrentTurn,
      ...(item.documentReadOverLimit ? { documentReadOverLimit: true } : {}),
    })
  }
  return files
}

export function turnContextImagesFromHydrated(
  hydrated: readonly HydratedChannelAttachment[]
): TurnContextAttachedImage[] {
  const images: TurnContextAttachedImage[] = []
  for (const item of hydrated) {
    if (!item.isImage) continue
    images.push({
      attachmentId: item.row.attachment_id,
      name: item.fileReference.name,
      mimeType: item.fileReference.detectedMediaType,
      byteLength: item.row.byte_length,
      retained: !item.isCurrentTurn,
    })
  }
  return images
}

function describeReadability(item: HydratedChannelAttachment): string {
  const ref = item.fileReference
  if (item.isImage) {
    if (item.row.visual_valid === 1) {
      return `${ref.class} image (retained; visual inspection available on vision-capable models)`
    }
    return `${ref.class} image (retained; unsupported image container framing for vision models, still saveable)`
  }
  if (ref.reader === 'text') {
    return `${ref.class} (readable text)`
  }
  if (ref.reader === 'pdf' || ref.reader === 'xlsx') {
    if (item.documentReadOverLimit) {
      const limitMiB = Math.floor(DEFAULT_DOCUMENT_READ_LIMITS.maxSourceBytes / (1024 * 1024))
      return `${ref.class} (retained; exceeds ${limitMiB} MiB document-read limit — direct reading unavailable, can still be saved within upload limits)`
    }
    return `${ref.class} (readable ${ref.reader.toUpperCase()} document)`
  }
  return `${ref.class} (retained; no direct text reader for this file format)`
}

/**
 * Deterministic confirmation reply for attachment-only channel turns (`X9`,
 * `R2`, `R8`, `R13`, `R33`, `R53`). Zero LLM calls, zero tool executions.
 */
export function buildAttachmentOnlyConfirmationReply(params: {
  received: readonly HydratedChannelAttachment[]
  ingestErrors?: readonly ChannelAttachmentIngestError[]
}): string {
  const lines: string[] = []
  const received = params.received
  const errors = params.ingestErrors ?? []

  if (received.length > 0) {
    lines.push(received.length === 1 ? 'Received 1 file:' : `Received ${received.length} files:`)
    for (const item of received) {
      lines.push(`- ${item.fileReference.name} — ${describeReadability(item)}`)
    }
  }

  if (errors.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(
      errors.length === 1
        ? '1 attachment could not be processed:'
        : `${errors.length} attachments could not be processed:`
    )
    for (const err of errors) {
      const label = err.filename?.trim() || 'attachment'
      lines.push(`- ${label}: ${err.message} (${err.code})`)
    }
  }

  if (received.length === 0 && errors.length === 0) {
    lines.push('No readable attachments were found for this message.')
  }

  lines.push('')
  lines.push(
    received.length > 0
      ? 'What would you like me to do with these files?'
      : 'Please resend the file or tell me how you would like to proceed.'
  )
  return lines.join('\n')
}
