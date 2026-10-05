// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComposerImageAttachment } from '../../../uiTypes'
import { AnnotationCanvas, commitAnnotatedPreview } from '../AnnotationCanvas'

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

describe('AnnotationCanvas copy action', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  it('copies the attached image bytes and confirms success', async () => {
    const write = vi.fn(async () => undefined)
    const clipboardItems: Array<Record<string, Blob>> = []
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(data: Record<string, Blob>) {
          clipboardItems.push(data)
        }
      }
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })

    render(
      <AnnotationCanvas
        attachment={attachment('data:image/png;base64,AAAA')}
        onSave={vi.fn()}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Annotate' }).querySelector('svg')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }))

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    expect(clipboardItems[0]?.['image/png']?.size).toBe(3)
    expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
  })
})
