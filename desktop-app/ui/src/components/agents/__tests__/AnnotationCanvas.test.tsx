// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { commitAnnotatedPreview } from '../AnnotationCanvas'

const attachment = (previewDataUrl: string): ComposerImageAttachment => ({
  id: 'att-1',
  name: 'note.png',
  mimeType: 'image/png',
  dataBase64: 'AAAA',
  sizeBytes: 4,
  previewDataUrl,
})

describe('commitAnnotatedPreview', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('revokes the created blob URL when onSave throws', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const created = 'blob:http://localhost/annotated'
    const serialized = 'data:image/png;base64,AAAA'

    expect(() =>
      commitAnnotatedPreview(
        () => {
          throw new Error('kept unchanged')
        },
        attachment(created),
        created,
        serialized
      )
    ).toThrow('kept unchanged')

    expect(revoke).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith(created)
  })

  it('does not revoke when onSave accepts the replacement', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const created = 'blob:http://localhost/annotated'
    const next = attachment(created)
    const onSave = vi.fn()

    commitAnnotatedPreview(onSave, next, created, 'data:image/png;base64,AAAA')

    expect(onSave).toHaveBeenCalledWith(next)
    expect(revoke).not.toHaveBeenCalled()
  })
})
