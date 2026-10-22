// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  vi.restoreAllMocks()
})

describe('FilePreviewPage focus revalidation', () => {
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
