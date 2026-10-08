import { createHash, randomUUID } from 'node:crypto'
import type {
  Attachment,
  ChatMessage,
  MessageContentImageSource,
  MessageContentPart,
} from '../core/types'
import type {
  ModelStepCheckpointAttachmentInput,
  ModelStepCheckpointAttachmentRow,
} from '../db/worker/modelStepCheckpointOps'
import type { GfsImageSource } from '../visualInput/policy'

/** A runtime image part; its bytes are inline on the loop's transcript. */
type RuntimeImagePart = Extract<MessageContentPart, { type: 'image' }>

/**
 * #1043 (C3/C8) — one inline image exactly as a checkpoint entry JSON stores
 * it. The bytes live in `model_step_checkpoint_attachments` under
 * `checkpointAttachmentId` and expire at `checkpointAttachmentExpiresAt`; the
 * entry itself never carries `data`.
 */
export interface RecordedCheckpointImagePart {
  type: 'checkpoint-image'
  checkpointAttachmentId: string
  /**
   * Absolute first-capture deadline. A retry repeats this value; the store
   * refuses a different one, so retention can never be extended.
   */
  checkpointAttachmentExpiresAt: number
  /** sha256 of the captured bytes; authoritative over the byte table. */
  checkpointAttachmentDigestHex: string
  mimeType: 'image/jpeg' | 'image/png'
  sourceIdentityOnly?: true
  width?: number
  height?: number
  source?: MessageContentImageSource | GfsImageSource
}

/** A checkpoint entry's content parts: runtime parts, without inline image bytes. */
export type RecordedCheckpointContentPart =
  | Exclude<MessageContentPart, { type: 'image' }>
  | RecordedCheckpointImagePart

/** One transcript message exactly as a checkpoint entry JSON stores it. */
export type RecordedCheckpointMessage = Omit<ChatMessage, 'contentParts'> & {
  contentParts?: RecordedCheckpointContentPart[]
}

/** A part as it can actually be read back, including a pre-contract inline image. */
type PersistedContentPart = RecordedCheckpointContentPart | RuntimeImagePart

/** Byte-retention clock and window shared by files and transcript images. */
export interface CheckpointByteRetention {
  now: () => number
  ttlMs: number
}

/**
 * Raw bytes of the turn's inline uploaded files. A continuation passes the rows
 * it restored so the first capture's deadline is reused: a late retry repeats
 * the original window instead of opening a new one. The digest is recomputed
 * from the bytes; when admission recorded one, the two must agree.
 */
export function inlineFileAttachmentBytes(
  attachments: readonly Attachment[] | undefined,
  retention: CheckpointByteRetention,
  restored: readonly ModelStepCheckpointAttachmentRow[]
): ModelStepCheckpointAttachmentInput[] {
  const restoredById = new Map(restored.map(row => [row.attachment_id, row]))
  const result: ModelStepCheckpointAttachmentInput[] = []
  for (const attachment of attachments ?? []) {
    if (attachment.kind !== 'file' || attachment.dataBase64.length === 0) continue
    const bytes = Buffer.from(attachment.dataBase64, 'base64')
    const digestHex = createHash('sha256').update(bytes).digest('hex')
    if (attachment.digest && attachment.digest.hex !== digestHex) {
      throw new Error(`Inline attachment ${attachment.id} does not match its admitted digest`)
    }
    const firstCapture = restoredById.get(attachment.id)
    if (
      firstCapture &&
      (firstCapture.digest_hex !== digestHex || firstCapture.size_bytes !== bytes.byteLength)
    ) {
      throw new Error(`Inline attachment ${attachment.id} does not match its checkpoint bytes`)
    }
    result.push({
      attachmentId: attachment.id,
      digestHex,
      bytes,
      // The restored row's deadline is the first capture's; only a first
      // capture may start a new window.
      expiresAt: firstCapture ? firstCapture.expires_at : retention.now() + retention.ttlMs,
    })
  }
  return result
}

interface CapturedImageBinding {
  attachmentId: string
  expiresAt: number
}

export interface CheckpointImageCapture {
  /** Replaces one runtime image part with its durable reference. */
  capture(part: RuntimeImagePart): RecordedCheckpointImagePart
  /** Bytes to write with the checkpoint's next `resumable` transition. */
  pendingAttachments(): ModelStepCheckpointAttachmentInput[]
}

/**
 * Captures the inline image bytes of one recording session. The durable id and
 * the first-capture deadline are decided once per byte set, keyed by sha256: a
 * retry that re-captures the same bytes reuses the row's identity and deadline,
 * even after the sweep deleted that row.
 */
export function createCheckpointImageCapture(
  restored: readonly ModelStepCheckpointAttachmentRow[],
  retention: CheckpointByteRetention
): CheckpointImageCapture {
  const bindings = new Map<string, CapturedImageBinding>()
  const pending = new Map<string, ModelStepCheckpointAttachmentInput>()
  for (const row of restored) {
    const digestHex = createHash('sha256').update(row.bytes).digest('hex')
    if (digestHex !== row.digest_hex) {
      throw new Error(`Checkpoint attachment ${row.attachment_id} does not match its stored digest`)
    }
    // Duplicate rows with one digest are legitimate: deduplicated files and
    // images share a byte set. The set's retention is its FIRST capture, so the
    // earliest deadline wins; a later duplicate can never extend the window.
    // Equal deadlines tie-break on the smaller id so the binding never depends
    // on the rows' order.
    const existing = bindings.get(digestHex)
    if (
      !existing ||
      row.expires_at < existing.expiresAt ||
      (row.expires_at === existing.expiresAt && row.attachment_id < existing.attachmentId)
    ) {
      bindings.set(digestHex, { attachmentId: row.attachment_id, expiresAt: row.expires_at })
    }
  }

  return {
    capture(part: RuntimeImagePart): RecordedCheckpointImagePart {
      if (part.data.length === 0) {
        throw new Error('Model-step checkpoint image part has no inline bytes to capture')
      }
      const bytes = Buffer.from(part.data, 'base64')
      const digestHex = createHash('sha256').update(bytes).digest('hex')
      let binding = bindings.get(digestHex)
      if (!binding) {
        binding = {
          attachmentId: randomUUID(),
          expiresAt: retention.now() + retention.ttlMs,
        }
        bindings.set(digestHex, binding)
      }
      if (!pending.has(binding.attachmentId)) {
        pending.set(binding.attachmentId, {
          attachmentId: binding.attachmentId,
          digestHex,
          bytes,
          expiresAt: binding.expiresAt,
        })
      }
      return {
        type: 'checkpoint-image',
        checkpointAttachmentId: binding.attachmentId,
        checkpointAttachmentExpiresAt: binding.expiresAt,
        checkpointAttachmentDigestHex: digestHex,
        mimeType: part.mimeType,
        ...(part.sourceIdentityOnly ? { sourceIdentityOnly: true as const } : {}),
        ...(part.width === undefined ? {} : { width: part.width }),
        ...(part.height === undefined ? {} : { height: part.height }),
        ...(part.source === undefined ? {} : { source: part.source }),
      }
    },
    pendingAttachments(): ModelStepCheckpointAttachmentInput[] {
      return [...pending.values()]
    },
  }
}

export interface CheckpointAttachmentRestoreFailure {
  code: 'missing_or_expired' | 'tampered'
  attachmentId: string
}

export type CheckpointAttachmentRestoreResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; failure: CheckpointAttachmentRestoreFailure }

/**
 * Rebuilds provider-safe runtime messages from a checkpoint's recorded
 * references. The recorded deadline is authoritative (it survives the sweep
 * deleting the row), and the bytes must still match their digest. Nothing is
 * partially restored: the first failing part fails the whole result.
 *
 * A persisted message that still carries inline `image` bytes breaks the
 * retention contract. It fails as `tampered` when it names a durable id, and
 * throws when it does not, because there is no identity to report.
 */
export function restoreCheckpointMessages(
  messages: readonly RecordedCheckpointMessage[],
  rows: readonly ModelStepCheckpointAttachmentRow[],
  now: number
): CheckpointAttachmentRestoreResult {
  const rowsById = new Map(rows.map(row => [row.attachment_id, row]))
  const restored: ChatMessage[] = []
  for (const message of messages) {
    const parts = message.contentParts
    if (!parts) {
      restored.push({ ...message, contentParts: undefined })
      continue
    }
    const restoredParts: MessageContentPart[] = []
    for (const part of parts) {
      const result = restorePart(part, rowsById, now)
      // Nothing is partially restored: the first failing part fails the whole
      // result, and the caller never reads the messages it did not return.
      if (!result.ok) return { ok: false, failure: result.failure }
      restoredParts.push(result.part)
    }
    restored.push({ ...message, contentParts: restoredParts })
  }
  return { ok: true, messages: restored }
}

type PartRestoreResult =
  | { ok: true; part: MessageContentPart }
  | { ok: false; failure: CheckpointAttachmentRestoreFailure }

function restorePart(
  part: PersistedContentPart,
  rowsById: ReadonlyMap<string, ModelStepCheckpointAttachmentRow>,
  now: number
): PartRestoreResult {
  if (part.type === 'image') {
    const sourceAttachmentId = sourceAttachmentIdOf(part)
    if (!sourceAttachmentId) {
      throw new Error(
        'Model-step checkpoint entry carries inline image bytes without a durable attachment id'
      )
    }
    return { ok: false, failure: { code: 'tampered', attachmentId: sourceAttachmentId } }
  }
  if (part.type !== 'checkpoint-image') return { ok: true, part }

  const row = rowsById.get(part.checkpointAttachmentId)
  // The reference's first-capture deadline is authoritative: an extended row
  // can never revive bytes whose own window has already elapsed.
  if (!row || part.checkpointAttachmentExpiresAt <= now || row.expires_at <= now) {
    return {
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: part.checkpointAttachmentId },
    }
  }
  if (row.expires_at !== part.checkpointAttachmentExpiresAt) {
    return { ok: false, failure: { code: 'tampered', attachmentId: part.checkpointAttachmentId } }
  }
  const bytes = Buffer.from(row.bytes)
  const digestHex = createHash('sha256').update(bytes).digest('hex')
  if (
    bytes.byteLength !== row.size_bytes ||
    row.digest_hex !== part.checkpointAttachmentDigestHex ||
    digestHex !== part.checkpointAttachmentDigestHex
  ) {
    return { ok: false, failure: { code: 'tampered', attachmentId: part.checkpointAttachmentId } }
  }
  return {
    ok: true,
    part: {
      type: 'image',
      mimeType: part.mimeType,
      data: bytes.toString('base64'),
      ...(part.sourceIdentityOnly ? { sourceIdentityOnly: true as const } : {}),
      ...(part.width === undefined ? {} : { width: part.width }),
      ...(part.height === undefined ? {} : { height: part.height }),
      ...(part.source === undefined ? {} : { source: part.source }),
    },
  }
}

function sourceAttachmentIdOf(part: RuntimeImagePart): string | undefined {
  const source = part.source
  if (!source || typeof source !== 'object') return undefined
  const attachmentId = (source as { attachmentId?: unknown }).attachmentId
  return typeof attachmentId === 'string' && attachmentId.length > 0 ? attachmentId : undefined
}
