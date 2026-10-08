/**
 * #1043 (C3/C8) — the durable byte envelope: files and transcript images leave
 * the checkpoint entries as references, every byte set keeps the deadline of
 * its FIRST capture, and a restore either rebuilds fully valid runtime messages
 * or names the part that failed.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { Attachment, ChatMessage, MessageContentPart } from '../../core/types'
import type { ModelStepCheckpointAttachmentRow } from '../../db/worker/modelStepCheckpointOps'
import {
  type RecordedCheckpointImagePart,
  type RecordedCheckpointMessage,
  createCheckpointImageCapture,
  inlineFileAttachmentBytes,
  restoreCheckpointMessages,
} from '../modelStepCheckpointAttachments'

const NOW = 1_700_000_000_000
const TTL_MS = 3_600_000

type RuntimeImagePart = Extract<MessageContentPart, { type: 'image' }>

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function attachment(overrides: Partial<Attachment> & Pick<Attachment, 'id' | 'kind'>): Attachment {
  return { mimeType: 'text/plain', encoding: 'base64', dataBase64: '', ...overrides }
}

function runtimeImageMessage(text: string, part: Partial<RuntimeImagePart> = {}): ChatMessage {
  const bytes = Buffer.from(text, 'utf8')
  return {
    role: 'user',
    content: 'look at this',
    contentParts: [
      { type: 'text', text: 'look at this' },
      {
        type: 'image',
        mimeType: 'image/png',
        data: bytes.toString('base64'),
        width: 3,
        height: 2,
        source: { kind: 'attachment', attachmentId: 'att-image', messageId: 'msg-1' },
        ...part,
      },
    ],
  }
}

function rowFor(
  reference: RecordedCheckpointImagePart,
  bytes: Buffer,
  overrides: Partial<ModelStepCheckpointAttachmentRow> = {}
): ModelStepCheckpointAttachmentRow {
  return {
    attachment_id: reference.checkpointAttachmentId,
    digest_hex: reference.checkpointAttachmentDigestHex,
    size_bytes: bytes.byteLength,
    bytes,
    expires_at: reference.checkpointAttachmentExpiresAt,
    ...overrides,
  }
}

function recordedMessage(
  parts: RecordedCheckpointMessage['contentParts']
): RecordedCheckpointMessage {
  return { role: 'user', content: 'look at this', contentParts: parts }
}

function imagePartOf(message: ChatMessage): RuntimeImagePart {
  const part = message.contentParts?.find(candidate => candidate.type === 'image')
  if (!part || part.type !== 'image') throw new Error('restored message has no image part')
  return part
}

function captureOne(
  text: string,
  options: { restored?: ModelStepCheckpointAttachmentRow[]; now?: number } = {}
) {
  const capture = createCheckpointImageCapture(options.restored ?? [], {
    now: () => options.now ?? NOW,
    ttlMs: TTL_MS,
  })
  const message = runtimeImageMessage(text)
  const part = imagePartOf(message)
  return { capture, reference: capture.capture(part), bytes: Buffer.from(part.data, 'base64') }
}

describe('inlineFileAttachmentBytes (#1043 C3/C8)', () => {
  it('returns the raw bytes of inline files only and starts their first window', () => {
    const file = Buffer.from('file bytes')
    const image = Buffer.from('image bytes')
    const result = inlineFileAttachmentBytes(
      [
        attachment({
          id: 'file-1',
          kind: 'file',
          dataBase64: file.toString('base64'),
          digest: { algorithm: 'sha256', hex: sha256(file) },
        }),
        attachment({ id: 'image-1', kind: 'image', dataBase64: image.toString('base64') }),
        attachment({ id: 'file-empty', kind: 'file' }),
      ],
      { now: () => NOW, ttlMs: TTL_MS },
      []
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      attachmentId: 'file-1',
      digestHex: sha256(file),
      expiresAt: NOW + TTL_MS,
    })
    expect(Buffer.compare(Buffer.from(result[0]!.bytes), file)).toBe(0)
  })

  it('keeps the restored first-capture deadline when a retry re-reads the bytes', () => {
    const file = Buffer.from('file bytes')
    const firstDeadline = NOW + TTL_MS
    const restored: ModelStepCheckpointAttachmentRow[] = [
      {
        attachment_id: 'file-1',
        digest_hex: sha256(file),
        size_bytes: file.byteLength,
        bytes: file,
        expires_at: firstDeadline,
      },
    ]
    const later = NOW + 30 * 60_000
    const result = inlineFileAttachmentBytes(
      [
        attachment({
          id: 'file-1',
          kind: 'file',
          dataBase64: file.toString('base64'),
          digest: { algorithm: 'sha256', hex: sha256(file) },
        }),
      ],
      { now: () => later, ttlMs: TTL_MS },
      restored
    )
    // The retry repeats the original window; it never opens a new one.
    expect(result[0]!.expiresAt).toBe(firstDeadline)
  })

  it('refuses bytes that do not match the admitted digest', () => {
    expect(() =>
      inlineFileAttachmentBytes(
        [
          attachment({
            id: 'file-1',
            kind: 'file',
            dataBase64: Buffer.from('tampered').toString('base64'),
            digest: { algorithm: 'sha256', hex: sha256(Buffer.from('original')) },
          }),
        ],
        { now: () => NOW, ttlMs: TTL_MS },
        []
      )
    ).toThrow('Inline attachment file-1 does not match its admitted digest')

    // Positive witness: the same call with the admitted digest returns the bytes.
    const original = Buffer.from('original')
    const accepted = inlineFileAttachmentBytes(
      [
        attachment({
          id: 'file-1',
          kind: 'file',
          dataBase64: original.toString('base64'),
          digest: { algorithm: 'sha256', hex: sha256(original) },
        }),
      ],
      { now: () => NOW, ttlMs: TTL_MS },
      []
    )
    expect(accepted).toHaveLength(1)
  })

  it('refuses restored bytes that no longer match their checkpoint row', () => {
    const bytes = Buffer.from('file bytes')
    const restored: ModelStepCheckpointAttachmentRow[] = [
      {
        attachment_id: 'file-1',
        digest_hex: sha256(Buffer.from('other bytes')),
        size_bytes: bytes.byteLength,
        bytes,
        expires_at: NOW + TTL_MS,
      },
    ]
    expect(() =>
      inlineFileAttachmentBytes(
        [
          attachment({
            id: 'file-1',
            kind: 'file',
            dataBase64: bytes.toString('base64'),
          }),
        ],
        { now: () => NOW, ttlMs: TTL_MS },
        restored
      )
    ).toThrow('Inline attachment file-1 does not match its checkpoint bytes')

    // Positive witness: a row whose digest matches the bytes is accepted.
    const accepted = inlineFileAttachmentBytes(
      [attachment({ id: 'file-1', kind: 'file', dataBase64: bytes.toString('base64') })],
      { now: () => NOW, ttlMs: TTL_MS },
      [{ ...restored[0]!, digest_hex: sha256(bytes) }]
    )
    expect(accepted[0]!.expiresAt).toBe(NOW + TTL_MS)
  })

  it('returns nothing for a turn without attachments', () => {
    expect(inlineFileAttachmentBytes(undefined, { now: () => NOW, ttlMs: TTL_MS }, [])).toEqual([])

    // Positive liveness witness for the same call: a real file in the turn
    // returns its bytes under the first-capture deadline.
    const bytes = Buffer.from('file bytes')
    const captured = inlineFileAttachmentBytes(
      [attachment({ id: 'file-1', kind: 'file', dataBase64: bytes.toString('base64') })],
      { now: () => NOW, ttlMs: TTL_MS },
      []
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({
      attachmentId: 'file-1',
      digestHex: sha256(bytes),
      expiresAt: NOW + TTL_MS,
    })
    expect(Buffer.compare(Buffer.from(captured[0]!.bytes), bytes)).toBe(0)
  })
})

describe('createCheckpointImageCapture (#1043 C3/C8)', () => {
  it('mints one durable reference per byte set and holds the bytes for the transition', () => {
    const capture = createCheckpointImageCapture([], { now: () => NOW, ttlMs: TTL_MS })
    const message = runtimeImageMessage('same frame')
    const first = capture.capture(imagePartOf(message))
    // The same bytes in a second message reuse the identity and the window.
    const second = capture.capture(imagePartOf(runtimeImageMessage('same frame')))

    expect(first.type).toBe('checkpoint-image')
    expect(first).not.toHaveProperty('data')
    expect(first.checkpointAttachmentExpiresAt).toBe(NOW + TTL_MS)
    expect(first.checkpointAttachmentDigestHex).toBe(sha256(Buffer.from('same frame')))
    expect(second.checkpointAttachmentId).toBe(first.checkpointAttachmentId)
    expect(second.checkpointAttachmentExpiresAt).toBe(first.checkpointAttachmentExpiresAt)

    const pending = capture.pendingAttachments()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      attachmentId: first.checkpointAttachmentId,
      digestHex: first.checkpointAttachmentDigestHex,
      expiresAt: first.checkpointAttachmentExpiresAt,
    })
    expect(Buffer.compare(Buffer.from(pending[0]!.bytes), Buffer.from('same frame'))).toBe(0)
  })

  it('reuses a restored id and deadline and gives genuinely new bytes their own window', () => {
    const restoredBytes = Buffer.from('restored frame')
    const restored: ModelStepCheckpointAttachmentRow[] = [
      {
        attachment_id: 'att-restored',
        digest_hex: sha256(restoredBytes),
        size_bytes: restoredBytes.byteLength,
        bytes: restoredBytes,
        expires_at: NOW + 10 * 60_000,
      },
    ]
    const later = NOW + 5 * 60_000
    const capture = createCheckpointImageCapture(restored, { now: () => later, ttlMs: TTL_MS })

    const reused = capture.capture(imagePartOf(runtimeImageMessage('restored frame')))
    expect(reused.checkpointAttachmentId).toBe('att-restored')
    expect(reused.checkpointAttachmentExpiresAt).toBe(NOW + 10 * 60_000)

    const fresh = capture.capture(imagePartOf(runtimeImageMessage('tool-produced frame')))
    expect(fresh.checkpointAttachmentId).not.toBe('att-restored')
    expect(fresh.checkpointAttachmentExpiresAt).toBe(later + TTL_MS)

    expect(capture.pendingAttachments()).toHaveLength(2)
  })

  it('keeps the earliest first-capture deadline when duplicate digests restore in either row order', () => {
    const bytes = Buffer.from('deduplicated frame')
    const digest = sha256(bytes)
    const earliest = NOW + 60_000
    // The same bytes were captured twice; the later row must never extend the
    // first window (C8).
    const earlyRow: ModelStepCheckpointAttachmentRow = {
      attachment_id: 'att-early',
      digest_hex: digest,
      size_bytes: bytes.byteLength,
      bytes,
      expires_at: earliest,
    }
    const lateRow: ModelStepCheckpointAttachmentRow = {
      attachment_id: 'att-late',
      digest_hex: digest,
      size_bytes: bytes.byteLength,
      bytes: Buffer.from(bytes),
      expires_at: NOW + 600_000,
    }

    const forward = createCheckpointImageCapture([earlyRow, lateRow], {
      now: () => NOW,
      ttlMs: TTL_MS,
    })
    const reversed = createCheckpointImageCapture([lateRow, earlyRow], {
      now: () => NOW,
      ttlMs: TTL_MS,
    })
    const forwardRef = forward.capture(imagePartOf(runtimeImageMessage('deduplicated frame')))
    const reversedRef = reversed.capture(imagePartOf(runtimeImageMessage('deduplicated frame')))

    // The first capture wins in either order: same deadline, same identity.
    expect(forwardRef).toMatchObject({
      checkpointAttachmentId: 'att-early',
      checkpointAttachmentExpiresAt: earliest,
    })
    expect(reversedRef.checkpointAttachmentId).toBe(forwardRef.checkpointAttachmentId)
    expect(reversedRef.checkpointAttachmentExpiresAt).toBe(forwardRef.checkpointAttachmentExpiresAt)

    // Equal deadlines keep one stable identity too: the smaller id wins in
    // either order.
    const tiedFirst: ModelStepCheckpointAttachmentRow = { ...earlyRow, attachment_id: 'att-b' }
    const tiedSecond: ModelStepCheckpointAttachmentRow = { ...earlyRow, attachment_id: 'att-a' }
    for (const rows of [
      [tiedFirst, tiedSecond],
      [tiedSecond, tiedFirst],
    ]) {
      const tied = createCheckpointImageCapture(rows, { now: () => NOW, ttlMs: TTL_MS })
      expect(tied.capture(imagePartOf(runtimeImageMessage('deduplicated frame')))).toMatchObject({
        checkpointAttachmentId: 'att-a',
        checkpointAttachmentExpiresAt: earliest,
      })
    }

    // Liveness witness: while the first window is open, the retained bytes
    // restore from the duplicate rows in either order.
    const live = restoreCheckpointMessages(
      [recordedMessage([forwardRef])],
      [lateRow, earlyRow],
      NOW
    )
    expect(live.ok).toBe(true)
    if (live.ok) expect(imagePartOf(live.messages[0]!).data).toBe(bytes.toString('base64'))
    // Once the first window elapsed, the later duplicate row cannot revive it.
    expect(
      restoreCheckpointMessages([recordedMessage([forwardRef])], [earlyRow, lateRow], earliest)
    ).toEqual({
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: 'att-early' },
    })

    // Positive witness: genuinely new bytes are still first-captured now.
    const freshRef = reversed.capture(imagePartOf(runtimeImageMessage('fresh frame')))
    const freshBytes = Buffer.from('fresh frame')
    expect(freshRef.checkpointAttachmentId).not.toBe(forwardRef.checkpointAttachmentId)
    expect(freshRef.checkpointAttachmentExpiresAt).toBe(NOW + TTL_MS)
    const freshRestored = restoreCheckpointMessages(
      [recordedMessage([freshRef])],
      [
        {
          attachment_id: freshRef.checkpointAttachmentId,
          digest_hex: freshRef.checkpointAttachmentDigestHex,
          size_bytes: freshBytes.byteLength,
          bytes: freshBytes,
          expires_at: freshRef.checkpointAttachmentExpiresAt,
        },
      ],
      NOW
    )
    expect(freshRestored.ok).toBe(true)
    if (freshRestored.ok) {
      expect(imagePartOf(freshRestored.messages[0]!).data).toBe(freshBytes.toString('base64'))
    }
  })

  it('refuses an image part without inline bytes', () => {
    const capture = createCheckpointImageCapture([], { now: () => NOW, ttlMs: TTL_MS })
    const empty = runtimeImageMessage('')

    expect(() => capture.capture(imagePartOf(empty))).toThrow(
      'Model-step checkpoint image part has no inline bytes to capture'
    )
    // Positive witness: the same capture accepts a part that has bytes.
    expect(capture.capture(imagePartOf(runtimeImageMessage('frame'))).type).toBe('checkpoint-image')
  })

  it('refuses a restored row whose bytes no longer match its digest', () => {
    const bytes = Buffer.from('restored frame')
    const row: ModelStepCheckpointAttachmentRow = {
      attachment_id: 'att-restored',
      digest_hex: sha256(Buffer.from('other')),
      size_bytes: bytes.byteLength,
      bytes,
      expires_at: NOW + TTL_MS,
    }
    expect(() => createCheckpointImageCapture([row], { now: () => NOW, ttlMs: TTL_MS })).toThrow(
      'Checkpoint attachment att-restored does not match its stored digest'
    )
    // Positive witness: the same row with its true digest captures normally.
    const capture = createCheckpointImageCapture([{ ...row, digest_hex: sha256(bytes) }], {
      now: () => NOW,
      ttlMs: TTL_MS,
    })
    expect(capture.capture(imagePartOf(runtimeImageMessage('restored frame')))).toMatchObject({
      checkpointAttachmentId: 'att-restored',
    })
  })
})

describe('restoreCheckpointMessages (#1043 C3/C8)', () => {
  it('rebuilds the runtime image and drops the durable reference', () => {
    const { reference, bytes } = captureOne('frame bytes', {})
    const restored = restoreCheckpointMessages(
      [
        recordedMessage([
          { type: 'text', text: 'look at this' },
          { ...reference, sourceIdentityOnly: true, width: 7, height: 5 },
        ]),
      ],
      [rowFor(reference, bytes)],
      NOW
    )
    expect(restored.ok).toBe(true)
    if (!restored.ok) return
    const part = imagePartOf(restored.messages[0]!)
    expect(part).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      sourceIdentityOnly: true,
      width: 7,
      height: 5,
      source: { kind: 'attachment', attachmentId: 'att-image', messageId: 'msg-1' },
    })
    expect(part).not.toHaveProperty('checkpointAttachmentId')
    expect(restored.messages[0]).toMatchObject({ role: 'user', content: 'look at this' })
  })

  it('reports missing_or_expired for a swept row and restores while the bytes are live', () => {
    const { reference, bytes } = captureOne('frame bytes')
    const messages = [recordedMessage([reference])]

    expect(restoreCheckpointMessages(messages, [], NOW)).toEqual({
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: reference.checkpointAttachmentId },
    })
    // Positive witness: the same reference restores while its row is present.
    const live = restoreCheckpointMessages(messages, [rowFor(reference, bytes)], NOW)
    expect(live.ok).toBe(true)
    if (live.ok) expect(imagePartOf(live.messages[0]!).data).toBe(bytes.toString('base64'))
  })

  it('reports missing_or_expired when the reference window elapsed, even if a row was extended', () => {
    const { reference, bytes } = captureOne('frame bytes')
    const expired: RecordedCheckpointImagePart = {
      ...reference,
      checkpointAttachmentExpiresAt: NOW - 1,
    }
    const extendedRow = rowFor({ ...reference, checkpointAttachmentExpiresAt: NOW + TTL_MS }, bytes)

    expect(restoreCheckpointMessages([recordedMessage([expired])], [extendedRow], NOW)).toEqual({
      ok: false,
      failure: { code: 'missing_or_expired', attachmentId: reference.checkpointAttachmentId },
    })
    // Positive witness: a reference whose own window is still open restores.
    const live = restoreCheckpointMessages(
      [recordedMessage([{ ...reference, checkpointAttachmentExpiresAt: NOW + 1 }])],
      [rowFor({ ...reference, checkpointAttachmentExpiresAt: NOW + 1 }, bytes)],
      NOW
    )
    expect(live.ok).toBe(true)
  })

  it('reports tampered when the row deadline does not match the first capture', () => {
    const { reference, bytes } = captureOne('frame bytes')
    const extendedRow = rowFor(reference, bytes, {
      expires_at: reference.checkpointAttachmentExpiresAt + 60_000,
    })

    expect(restoreCheckpointMessages([recordedMessage([reference])], [extendedRow], NOW)).toEqual({
      ok: false,
      failure: { code: 'tampered', attachmentId: reference.checkpointAttachmentId },
    })
    // Positive witness: the row that repeats the first capture restores.
    const live = restoreCheckpointMessages(
      [recordedMessage([reference])],
      [rowFor(reference, bytes)],
      NOW
    )
    expect(live.ok).toBe(true)
  })

  it('reports tampered when the stored bytes no longer match the recorded digest', () => {
    const { reference, bytes } = captureOne('frame bytes')
    const swapped = Buffer.from('different frame')
    // The row is internally consistent; only the entry's digest can catch it.
    const tamperedRow = rowFor(reference, swapped, { digest_hex: sha256(swapped) })

    expect(restoreCheckpointMessages([recordedMessage([reference])], [tamperedRow], NOW)).toEqual({
      ok: false,
      failure: { code: 'tampered', attachmentId: reference.checkpointAttachmentId },
    })
    // Positive witness: the original bytes restore.
    const live = restoreCheckpointMessages(
      [recordedMessage([reference])],
      [rowFor(reference, bytes)],
      NOW
    )
    expect(live.ok).toBe(true)
  })

  it('reports a legacy inline image part and throws when it has no durable identity', () => {
    const legacy = {
      role: 'user',
      content: 'look at this',
      contentParts: [
        {
          type: 'image',
          mimeType: 'image/png',
          data: Buffer.from('legacy frame').toString('base64'),
          source: { kind: 'attachment', attachmentId: 'att-legacy', messageId: 'msg-1' },
        },
      ],
    } as unknown as RecordedCheckpointMessage

    expect(restoreCheckpointMessages([legacy], [], NOW)).toEqual({
      ok: false,
      failure: { code: 'tampered', attachmentId: 'att-legacy' },
    })
    const anonymous = {
      role: 'user',
      content: 'look at this',
      contentParts: [
        { type: 'image', mimeType: 'image/png', data: Buffer.from('legacy').toString('base64') },
      ],
    } as unknown as RecordedCheckpointMessage
    expect(() => restoreCheckpointMessages([anonymous], [], NOW)).toThrow(
      'Model-step checkpoint entry carries inline image bytes without a durable attachment id'
    )

    // Positive witness: a durable reference restores through the same call.
    const { reference, bytes } = captureOne('frame bytes')
    expect(
      restoreCheckpointMessages([recordedMessage([reference])], [rowFor(reference, bytes)], NOW).ok
    ).toBe(true)
  })

  it('passes through a recorded message without content parts', () => {
    const plain: RecordedCheckpointMessage = { role: 'assistant', content: 'done' }
    const restored = restoreCheckpointMessages([plain], [], NOW)
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.messages[0]).toEqual({ role: 'assistant', content: 'done' })
  })
})
