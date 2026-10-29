// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

describe('FilePreviewPage unchanged rename', () => {
  it('closes without mutation or success feedback when the normalized name is unchanged', async () => {
    const renameResource = vi.fn()
    const pushToast = vi.fn()
    const affordances = vi.fn(async () => delegationAffordances(new Set(['read', 'write']), false))
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 1) },
        gfs: {
          resolve: vi.fn(async () =>
            resolveResource({
              resourceId,
              rid: resourceId,
              gfsUri: uri,
              drive: 'main',
              parentResourceId: 'parent',
              name: 'diagram.png',
              kind: 'file',
              version: 7,
              bytes: 1,
            })
          ),
          affordances,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          renameResource,
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-rename-noop-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    render(
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />,
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      }
    )

    expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(resourceId, 'main'))
    fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
    expect((within(dialog).getByLabelText('New name') as HTMLInputElement).value).toBe(
      'diagram.png'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull())
    expect(renameResource).not.toHaveBeenCalled()
    expect(pushToast).not.toHaveBeenCalled()
    queryClient.clear()
  })
})
