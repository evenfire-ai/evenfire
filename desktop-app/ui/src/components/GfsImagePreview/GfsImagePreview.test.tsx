// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { GfsImagePreview } from './index'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('GfsImagePreview layout', () => {
  let sidebar: HTMLElement
  let sidebarRight = 74
  let resizeObserverCallback: (() => void) | null = null

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]).buffer })),
        },
      },
    })
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:gfs-image-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    })

    sidebar = document.createElement('aside')
    sidebar.className = 'left-nav collapsed'
    vi.spyOn(sidebar, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          right: sidebarRight,
          width: sidebarRight,
          height: 800,
        }) as DOMRect
    )
    document.body.appendChild(sidebar)

    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resizeObserverCallback = callback
        }

        observe() {}

        disconnect() {}
      }
    )
  })

  afterEach(() => {
    cleanup()
    sidebar.remove()
    resizeObserverCallback = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('centers in the workspace and follows sidebar expansion changes', async () => {
    render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="diagram.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )

    const modal = screen.getByRole('presentation')
    expect(await screen.findByRole('button', { name: 'Copy image to clipboard' })).toBeTruthy()
    const closeButton = screen.getByRole('button', { name: 'Close image preview' })
    expect(closeButton.classList.contains('ui-button')).toBe(true)
    expect(closeButton.classList.contains('da-gfs-image-preview-dialog__close')).toBe(true)
    const headerMain = screen
      .getByRole('dialog', { name: 'diagram.png' })
      .querySelector('.da-gfs-image-preview-dialog__header-main')
    expect(headerMain?.firstElementChild?.tagName).toBe('H3')
    expect(headerMain?.contains(closeButton)).toBe(false)
    expect((modal as HTMLElement).style.left).toBe('74px')
    expect((modal as HTMLElement).style.right).toBe('0px')

    sidebarRight = 328
    sidebar.classList.remove('collapsed')
    resizeObserverCallback?.()

    await waitFor(() => {
      expect((modal as HTMLElement).style.left).toBe('328px')
      expect((modal as HTMLElement).style.right).toBe('0px')
    })
  })

  it('keeps copying available for inline chat image attachments', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="chat-image.png"
        dataBase64="AQID"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )

    const copyButton = await screen.findByRole('button', { name: 'Copy image to clipboard' })
    expect(copyButton.classList.contains('da-gfs-image-preview-dialog__copy')).toBe(true)
    fireEvent.click(copyButton)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('data:image/png;base64,AQID'))
    expect(await screen.findByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
  })

  it('keeps copying available for GFS-backed image previews', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="drive-image.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByAltText('Preview of drive-image.png')).toBeTruthy()
    const copyButton = screen.getByRole('button', { name: 'Copy image to clipboard' })
    await waitFor(() => expect((copyButton as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(copyButton)

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('data:image/png;base64,AQID'))
    expect(await screen.findByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
  })

  it.each([
    {
      name: 'inline chat images',
      source: { dataBase64: 'AQID' as const },
      fileName: 'chat-image.png',
    },
    {
      name: 'GFS-backed images',
      source: { gfsUri: 'gfs://main/image-1' as const },
      fileName: 'drive-image.png',
    },
  ])('resets copied feedback after exactly two seconds for $name', async ({ source, fileName }) => {
    vi.useFakeTimers()
    const write = vi.fn(async () => undefined)
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(_items: Record<string, Blob>) {}
      }
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    const view = render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName={fileName}
        {...source}
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(write).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()

    await act(async () => vi.advanceTimersByTimeAsync(1_999))
    expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByRole('button', { name: 'Copy image to clipboard' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    {
      name: 'inline chat images',
      source: { dataBase64: 'AQID' as const },
      fileName: 'chat-image.png',
    },
    {
      name: 'GFS-backed images',
      source: { gfsUri: 'gfs://main/image-1' as const },
      fileName: 'drive-image.png',
    },
  ])(
    'keeps copy feedback for two seconds after the latest overlapping success for $name',
    async ({ source, fileName }) => {
      vi.useFakeTimers()
      const firstWrite = deferred<void>()
      const secondWrite = deferred<void>()
      const write = vi
        .fn()
        .mockImplementationOnce(() => firstWrite.promise)
        .mockImplementationOnce(() => secondWrite.promise)
      vi.stubGlobal(
        'ClipboardItem',
        class {
          constructor(_items: Record<string, Blob>) {}
        }
      )
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write },
      })
      render(
        <GfsImagePreview
          recordOpen={false}
          byteLength={3}
          fileName={fileName}
          {...source}
          mimeType="image/png"
          onClose={vi.fn()}
        />
      )
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })

      const copyButton = screen.getByRole('button', { name: 'Copy image to clipboard' })
      expect((copyButton as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(copyButton)
      fireEvent.click(copyButton)
      expect(write).toHaveBeenCalledTimes(2)

      await act(async () => {
        secondWrite.resolve(undefined)
        await secondWrite.promise
      })
      expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()

      await act(async () => vi.advanceTimersByTimeAsync(1_500))
      await act(async () => {
        firstWrite.resolve(undefined)
        await firstWrite.promise
      })
      expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()

      await act(async () => vi.advanceTimersByTimeAsync(500))
      expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
      await act(async () => vi.advanceTimersByTimeAsync(1_499))
      expect(screen.getByRole('button', { name: 'Copied image to clipboard' })).toBeTruthy()
      await act(async () => vi.advanceTimersByTimeAsync(1))
      expect(screen.getByRole('button', { name: 'Copy image to clipboard' })).toBeTruthy()
    }
  )

  it('does not schedule copy feedback when a deferred clipboard success arrives after unmount', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const pendingWrite = deferred<void>()
    const write = vi.fn(() => pendingWrite.promise)
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(_items: Record<string, Blob>) {}
      }
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    const view = render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="chat-image.png"
        dataBase64="AQID"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }))
    expect(write).toHaveBeenCalledOnce()
    view.unmount()
    const copiedTimerCountBeforeLateSuccess = setTimeoutSpy.mock.calls.filter(
      ([, delay]) => delay === 2_000
    ).length

    await act(async () => {
      pendingWrite.resolve(undefined)
      await pendingWrite.promise
    })
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 2_000).length).toBe(
      copiedTimerCountBeforeLateSuccess
    )
    expect(screen.queryByRole('button', { name: 'Copied image to clipboard' })).toBeNull()
  })

  it('does not apply a deferred copy success after the preview callback is replaced', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const pendingWrite = deferred<void>()
    const write = vi.fn(() => pendingWrite.promise)
    vi.stubGlobal(
      'ClipboardItem',
      class {
        constructor(_items: Record<string, Blob>) {}
      }
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { write },
    })
    const preview = (gfsUri: string) => (
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="drive-image.png"
        gfsUri={gfsUri}
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )
    const view = render(preview('gfs://main/image-1'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy image to clipboard' }))
    expect(write).toHaveBeenCalledOnce()
    view.rerender(preview('gfs://main/image-2'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    await act(async () => {
      pendingWrite.resolve(undefined)
      await pendingWrite.promise
    })
    expect(setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 2_000).length).toBe(0)
    expect(screen.getByRole('button', { name: 'Copy image to clipboard' })).toBeTruthy()
  })

  it('keeps the unavailable image dialog named and closable', async () => {
    const downloadPreview = vi.fn(async () => {
      throw new Error('404 File unavailable')
    })
    window.clerum.gfs.downloadPreview = downloadPreview
    render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="diagram.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        onClose={vi.fn()}
      />
    )

    expect(await screen.findByText(/File unavailable/)).toBeTruthy()
    const dialog = screen.getByRole('dialog', { name: 'diagram.png' })
    const title = screen.getByRole('heading', { name: 'diagram.png' })
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    expect(screen.getByRole('button', { name: 'Close image preview' })).toBeTruthy()
  })

  it('keeps the authoritative unavailable shell named and closable without fetching bytes', () => {
    const onClose = vi.fn()
    const downloadPreview = vi.mocked(window.clerum.gfs.downloadPreview)
    render(
      <GfsImagePreview
        recordOpen={false}
        byteLength={3}
        fileName="diagram.png"
        gfsUri="gfs://main/image-1"
        mimeType="image/png"
        onClose={onClose}
        unavailable
      />
    )

    const dialog = screen.getByRole('dialog', { name: 'File unavailable' })
    const title = within(dialog).getByRole('heading', { name: 'File unavailable', level: 3 })
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close image preview' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(downloadPreview).not.toHaveBeenCalled()
  })
})
