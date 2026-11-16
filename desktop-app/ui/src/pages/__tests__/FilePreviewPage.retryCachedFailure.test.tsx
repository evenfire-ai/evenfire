// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { GFS_AUTHORITY_STALE_TIME_MS } from '@lib/gfsAuthorityQueryPolicy'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '0123456789abcdef0123456789abcdef'
const uri = `gfs://main/${resourceId}`

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
})

describe('Preview Retry after a failed background refetch', () => {
  it('refetches a real cached Query and completes the admitted producer attempt', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    let failNextParentRead = false
    const sourceParentReads = vi.fn(async (id: string) => {
      if (id === 'source-parent' && failNextParentRead) {
        failNextParentRead = false
        throw parentFailure
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const produceAffordances = appServiceAffordanceProducer(id => sourceParentReads(id))
    const resolved = resolveResource({
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
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resolved),
          affordances: vi.fn((id: string) => produceAffordances(id)),
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
    const parentPermissionKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    try {
      render(
        <FilePreviewPage
          gfsUri={uri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />,
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
          ),
        }
      )
      expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
      const parentQuery = queryClient.getQueryCache().find({
        queryKey: parentPermissionKey,
        exact: true,
      })
      if (!parentQuery) throw new Error('Expected the real parent-permission Query')
      await waitFor(() => expect(parentQuery.state.status).toBe('success'))
      fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
      expect(await screen.findByRole('menuitem', { name: 'Delete' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
      queryClient.setQueryData(parentPermissionKey, parentQuery.state.data, {
        updatedAt: Date.now() - GFS_AUTHORITY_STALE_TIME_MS - 1,
      })
      const initialDataUpdateCount = parentQuery.state.dataUpdateCount
      const callsBeforeBackgroundFailure = sourceParentReads.mock.calls.length
      failNextParentRead = true

      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      expect(parentQuery.state.status).toBe('error')
      expect(parentQuery.state.data).toBeDefined()
      expect(parentQuery.state.dataUpdateCount).toBe(initialDataUpdateCount)
      expect(parentQuery.state.isInvalidated).toBe(true)
      expect(sourceParentReads).toHaveBeenCalledTimes(callsBeforeBackgroundFailure + 1)
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })

      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))

      await waitFor(() =>
        expect(sourceParentReads).toHaveBeenCalledTimes(callsBeforeBackgroundFailure + 2)
      )
      await waitFor(() => expect(parentQuery.state.status).toBe('success'))
      expect(parentQuery.state.dataUpdateCount).toBeGreaterThan(initialDataUpdateCount)
      expect(parentQuery.state.fetchStatus).toBe('idle')
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()
    } finally {
      queryClient.clear()
    }
  })
})
