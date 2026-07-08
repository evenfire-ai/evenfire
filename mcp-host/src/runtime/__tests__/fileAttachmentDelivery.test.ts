import { describe, expect, it } from 'vitest'
import type { Attachment } from '../../core/types'
import { ResultStore } from '../../resultStore'
import { entryHasFileAttachment, markFileAttachmentsDelivered } from '../fileAttachmentDelivery'

interface TestEntry {
  attachments?: Attachment[]
  storedAt: number
}

const fileAttachment: Attachment = {
  id: 'file-1',
  kind: 'file',
  mimeType: 'application/pdf',
  encoding: 'base64',
  dataBase64: 'redacted-test-file-data',
  filename: 'report.pdf',
  sourceTool: 'workflow_result',
}

const imageAttachment: Attachment = {
  id: 'image-1',
  kind: 'image',
  mimeType: 'image/jpeg',
  encoding: 'base64',
  dataBase64: 'redacted-test-image-data',
  filename: 'preview.jpg',
  sourceTool: 'image_generation',
}

function createStore(): ResultStore<TestEntry> {
  return new ResultStore<TestEntry>(10_000, entry => entry.storedAt)
}

describe('file attachment delivery state', () => {
  it('detects file attachments', () => {
    expect(entryHasFileAttachment({ attachments: [imageAttachment] })).toBe(false)
    expect(entryHasFileAttachment({ attachments: [fileAttachment] })).toBe(true)
  })

  it('removes file attachments from pending state after first delivery', () => {
    const store = createStore()
    const entry: TestEntry = {
      attachments: [fileAttachment, imageAttachment],
      storedAt: Date.now(),
    }
    store.set('task-1', entry)

    markFileAttachmentsDelivered(store, 'task-1', entry)

    expect(store.get('task-1')?.attachments).toEqual([imageAttachment])
  })

  it('removes the attachment field when only file attachments were pending', () => {
    const store = createStore()
    const entry: TestEntry = {
      attachments: [fileAttachment],
      storedAt: Date.now(),
    }
    store.set('task-1', entry)

    markFileAttachmentsDelivered(store, 'task-1', entry)

    expect(store.get('task-1')?.attachments).toBeUndefined()
  })
})
