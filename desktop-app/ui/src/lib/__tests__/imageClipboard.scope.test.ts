// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyImageBlobToClipboard } from '../imageClipboard'

describe('image clipboard scope ownership', () => {
  const originalClipboardItem = globalThis.ClipboardItem
  const originalCreateImageBitmap = globalThis.createImageBitmap
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')

  afterEach(() => {
    if (originalClipboardItem) {
      Object.defineProperty(globalThis, 'ClipboardItem', {
        configurable: true,
        value: originalClipboardItem,
      })
    } else {
      Reflect.deleteProperty(globalThis, 'ClipboardItem')
    }
    if (originalCreateImageBitmap) {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      })
    } else {
      Reflect.deleteProperty(globalThis, 'createImageBitmap')
    }
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
    vi.restoreAllMocks()
  })

  it('stops a converted image copy when its GFS Preview scope changes', async () => {
    let finishBitmap!: (bitmap: ImageBitmap) => void
    const bitmapPromise = new Promise<ImageBitmap>(resolve => {
      finishBitmap = resolve
    })
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: class ClipboardItemStub {
        constructor(readonly items: Record<string, Blob>) {
          void this.items
        }
      },
    })
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: vi.fn(() => bitmapPromise),
    })
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback => {
      callback(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    })
    const write = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { ...(navigator.clipboard ?? {}), write },
    })
    let scopeCurrent = true
    const copying = copyImageBlobToClipboard(
      new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
      () => scopeCurrent
    )

    scopeCurrent = false
    finishBitmap({ width: 1, height: 1 } as ImageBitmap)

    await expect(copying).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
