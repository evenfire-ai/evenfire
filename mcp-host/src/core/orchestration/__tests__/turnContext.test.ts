import { describe, expect, it } from 'vitest'
import type { FileReferenceV1 } from '@clerum/gfs-interaction-policy'
import type { Attachment } from '../../types'
import {
  ATTACHED_FILES_INSTRUCTION,
  type TurnContextAttachedFile,
  attachedFilesForTurnContext,
  buildTurnContextBlock,
} from '../turnContext'

describe('buildTurnContextBlock (T2.2)', () => {
  it('includes date and channel; omits sender when not provided', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'telegram' },
    })
    expect(block).toBe(
      '<turn-context>\ndate: 2026-05-19T14:30:00.000Z\nchannel: telegram\n</turn-context>\n\n'
    )
  })

  it('includes sender when present', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'telegram', sender: 'jane@example.com' },
    })
    expect(block).toContain('sender: jane@example.com')
  })

  it('includes cron_job and scheduled_for when cron is set', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'cron' },
      cron: { jobId: 'morning-digest', scheduledFor: '2026-05-19T08:00:00Z' },
    })
    expect(block).toContain('cron_job: morning-digest')
    expect(block).toContain('scheduled_for: 2026-05-19T08:00:00Z')
  })

  it('produces the canonical fence shape (open/close + double newline trailer)', () => {
    const block = buildTurnContextBlock({
      date: new Date('2026-05-19T14:30:00Z'),
      channel: { type: 'rpc', sender: 'jose' },
    })
    expect(block.startsWith('<turn-context>\n')).toBe(true)
    expect(block.endsWith('</turn-context>\n\n')).toBe(true)
  })
})

describe('attached_file lines (issue #666)', () => {
  const date = new Date('2026-05-19T14:30:00Z')
  const notes: TurnContextAttachedFile = {
    attachmentId: 'file-1',
    name: 'notes.md',
    class: 'markdown',
    byteLength: 42,
    reader: 'text',
    mismatch: false,
    declaredMediaType: 'text/markdown',
    detectedMediaType: 'text/markdown',
  }

  it('lists each file after the channel lines, followed by the fixed instruction', () => {
    const block = buildTurnContextBlock({
      date,
      channel: { type: 'rpc', sender: 'jose' },
      attachedFiles: [
        notes,
        {
          ...notes,
          attachmentId: 'file-2',
          name: 'report.pdf',
          class: 'pdf',
          byteLength: 9000,
          reader: 'none',
          declaredMediaType: 'application/pdf',
          detectedMediaType: 'application/pdf',
        },
      ],
    })
    expect(block).toBe(
      '<turn-context>\n' +
        'date: 2026-05-19T14:30:00.000Z\n' +
        'channel: rpc\n' +
        'sender: jose\n' +
        'attached_file: id=file-1 name="notes.md" class=markdown bytes=42 reader=text\n' +
        'attached_file: id=file-2 name="report.pdf" class=pdf bytes=9000 reader=none\n' +
        "If the user's request refers to an attached file, read it with clerum__attachment_read before answering. Files with reader=none cannot be read in this turn; say so instead of guessing.\n" +
        '</turn-context>\n\n'
    )
    expect(ATTACHED_FILES_INSTRUCTION).toBe(
      "If the user's request refers to an attached file, read it with clerum__attachment_read before answering. Files with reader=none cannot be read in this turn; say so instead of guessing."
    )
  })

  it('appends the declared and detected types when they disagree', () => {
    const block = buildTurnContextBlock({
      date,
      channel: { type: 'rpc' },
      attachedFiles: [
        {
          ...notes,
          name: 'invoice.txt',
          class: 'pdf',
          reader: 'none',
          mismatch: true,
          declaredMediaType: 'text/plain',
          detectedMediaType: 'application/pdf',
        },
      ],
    })
    expect(block).toContain(
      'attached_file: id=file-1 name="invoice.txt" class=pdf bytes=42 reader=none mismatch=true declared=text/plain detected=application/pdf\n'
    )
  })

  it('writes declared=none when the file had no declared media type', () => {
    const block = buildTurnContextBlock({
      date,
      channel: { type: 'rpc' },
      attachedFiles: [{ ...notes, mismatch: true, declaredMediaType: null }],
    })
    expect(block).toContain('reader=text mismatch=true declared=none detected=text/markdown\n')
  })

  it('quotes the user-chosen name so an embedded quote cannot end the field', () => {
    const block = buildTurnContextBlock({
      date,
      channel: { type: 'rpc' },
      attachedFiles: [{ ...notes, name: 'a" reader=text b.md' }],
    })
    expect(block).toContain('name="a\\" reader=text b.md" class=markdown bytes=42 reader=text\n')
  })

  it('emits neither lines nor instruction for a turn without files', () => {
    for (const attachedFiles of [undefined, []]) {
      const block = buildTurnContextBlock({ date, channel: { type: 'rpc' }, attachedFiles })
      // Witness: the block was built with its channel line.
      expect(block).toBe(
        '<turn-context>\ndate: 2026-05-19T14:30:00.000Z\nchannel: rpc\n</turn-context>\n\n'
      )
      expect(block).not.toContain('attached_file')
      expect(block).not.toContain('clerum__attachment_read')
    }
  })
})

describe('attachedFilesForTurnContext (issue #666)', () => {
  const fileReference: FileReferenceV1 = {
    schemaVersion: 1,
    id: `att:message-1:file-1@sha256:${'a'.repeat(64)}`,
    source: { kind: 'attachment', attachmentId: 'file-1', messageId: 'message-1' },
    name: 'notes.md',
    declaredMediaType: 'text/markdown',
    detectedMediaType: 'text/markdown',
    class: 'markdown',
    detection: 'text_utf8',
    mismatch: false,
    byteLength: 42,
    digest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
    textReadable: true,
    reader: 'text',
    modelImageInput: 'unsupported',
  }
  const image: Attachment = {
    id: 'image-1',
    kind: 'image',
    mimeType: 'image/png',
    encoding: 'base64',
    dataBase64: 'iVBORw0KGgo=',
  }
  const file: Attachment = {
    id: 'file-1',
    kind: 'file',
    mimeType: 'text/markdown',
    encoding: 'base64',
    dataBase64: 'IyBub3Rlcw==',
    filename: 'notes.md',
    sizeBytes: 42,
    fileReference,
  }

  it('maps each admitted file reference and skips images', () => {
    expect(attachedFilesForTurnContext([image, file])).toEqual([
      {
        attachmentId: 'file-1',
        name: 'notes.md',
        class: 'markdown',
        byteLength: 42,
        reader: 'text',
        mismatch: false,
        declaredMediaType: 'text/markdown',
        detectedMediaType: 'text/markdown',
      },
    ])
  })

  it('lists nothing for image-only, a file without reference, or absent attachments', () => {
    // Witness: the same function lists the admitted file.
    expect(attachedFilesForTurnContext([file])).toHaveLength(1)
    expect(attachedFilesForTurnContext([image])).toEqual([])
    expect(attachedFilesForTurnContext([{ ...file, fileReference: undefined }])).toEqual([])
    expect(attachedFilesForTurnContext(undefined)).toEqual([])
  })
})
