// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '0123456789abcdef0123456789abcdef'
const uri = `gfs://main/${resourceId}`

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FilePreviewPage focus revalidation', () => {
  it('deduplicates active permission reads inside the 15-second freshness window', async () => {
    const resolve = vi.fn(async () =>
      resolveResource({
        resourceId,
        rid: resourceId,
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    )
    const affordances = vi.fn(async (_id: string) =>
      delegationAffordances(new Set(['read', 'write', 'delete']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-focus-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function FocusAwarePreview() {
      useWindowFocusBridge()
      return (
        <FilePreviewPage
          gfsUri={uri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      )
    }
    const { unmount } = render(<FocusAwarePreview />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(resourceId, 'main'))
    const resourceReads = () => affordances.mock.calls.filter(([id]) => id === resourceId).length
    const parentReads = () => affordances.mock.calls.filter(([id]) => id === 'source-parent').length
    expect(resourceReads()).toBe(1)
    expect(parentReads()).toBe(1)

    vi.useFakeTimers()
    const initialReadAt = Date.now()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resourceReads()).toBe(1)
    expect(parentReads()).toBe(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_001)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resourceReads()).toBe(2)
    expect(parentReads()).toBe(2)
    expect(Date.now() - initialReadAt).toBeGreaterThan(15_000)

    unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resourceReads()).toBe(2)
    expect(parentReads()).toBe(2)
    vi.useRealTimers()
    queryClient.clear()
  })

  it('surfaces a source-parent 429 and suppresses focus retries until Retry-After expires', async () => {
    const sourceReads: string[] = []
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': Error: 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    const resolve = vi.fn(async () =>
      resolveResource({
        resourceId,
        rid: resourceId,
        gfsUri: uri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    )
    const affordances = vi.fn(async (id: string) => {
      if (id === 'source-parent') {
        sourceReads.push(id)
        if (sourceReads.length === 2) throw limited
      }
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
    const moveResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances,
          moveResource,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-focus-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function FocusAwarePreview() {
      useWindowFocusBridge()
      return (
        <FilePreviewPage
          gfsUri={uri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      )
    }
    render(<FocusAwarePreview />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(sourceReads).toHaveLength(1))
    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(sourceReads).toHaveLength(2)
    expect(
      queryClient.getQueryState(
        desktopQueryKeys.gfsAffordances('preview-focus-user:main', 'source-parent', 'main', 1)
      )?.status
    ).toBe('error')
    expect(screen.getByText(/Too many file requests/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sourceReads).toHaveLength(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000)
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(sourceReads).toHaveLength(3)
    expect(screen.queryByText(/Too many file requests/)).toBeNull()
    queryClient.clear()
  })

  it('uses one resolver request on focus and removes bytes after access is revoked', async () => {
    const denied = Object.assign(new Error('403 Forbidden'), { httpStatus: 403 })
    const pendingDenials: Array<(error: Error) => void> = []
    const resolve = vi
      .fn()
      .mockImplementationOnce(() =>
        resolveResource({
          resourceId,
          rid: resourceId,
          gfsUri: uri,
          drive: 'main',
          parentResourceId: 'source-parent',
          name: 'diagram.png',
          kind: 'file',
          version: 7,
          bytes: 1,
        })
      )
      .mockImplementation(
        () =>
          new Promise((_, reject) => {
            pendingDenials.push(reject)
          })
      )
    const affordances = vi.fn(async (..._args: [string, string]) =>
      delegationAffordances(new Set(['read']), false)
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-focus-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function FocusAwarePreview() {
      useWindowFocusBridge()
      return (
        <FilePreviewPage
          gfsUri={uri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      )
    }
    render(<FocusAwarePreview />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    })

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(affordances).toHaveBeenCalledWith('source-parent', 'main'))
    expect(affordances.mock.calls.filter(([id]) => id === 'source-parent')).toHaveLength(1)
    act(() => window.dispatchEvent(new Event('blur')))
    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    expect(affordances.mock.calls.filter(([id]) => id === 'source-parent')).toHaveLength(1)
    expect(pendingDenials).toHaveLength(1)
    await act(async () => {
      pendingDenials.forEach(reject => reject(denied))
    })
    expect(await screen.findByText('File unavailable')).toBeTruthy()
    expect(screen.queryByAltText('Preview of diagram.png')).toBeNull()
    queryClient.clear()
  })
})
