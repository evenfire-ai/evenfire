// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '0123456789abcdef0123456789abcdef'
const uri = `gfs://main/${resourceId}`
const sessionScope = 'preview-mutation-gap-user:main'

function PreviewWithToasts({ uriToPreview }: { uriToPreview: string }) {
  const toast = useToastController()
  return (
    <>
      <FilePreviewPage
        gfsUri={uriToPreview}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={toast.pushToast}
      />
      <ToastStack items={toast.toasts} onDismiss={toast.dismissToast} />
    </>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Preview mutation admission across a resolver gap', () => {
  it('does not continue Delete after the committed resource becomes unavailable', async () => {
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
    let rejectResolver!: (error: Error) => void
    const resolverFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
    const resolverGap = new Promise<never>((_resolve, reject) => {
      rejectResolver = reject
    })
    let releasePermissionRefetch!: (value: ReturnType<typeof heldPermissionResponse>) => void
    const pendingPermissionResponse = new Promise<ReturnType<typeof heldPermissionResponse>>(
      resolve => {
        releasePermissionRefetch = resolve
      }
    )
    let resourceAffordanceReads = 0
    const affordanceProducer = appServiceAffordanceProducer(async requestedId => {
      if (requestedId !== resourceId) return heldPermissionResponse(['read', 'write', 'delete'])
      resourceAffordanceReads += 1
      if (resourceAffordanceReads === 2) return pendingPermissionResponse
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    let resolverReads = 0
    const resolve = vi.fn(async () => {
      resolverReads += 1
      if (resolverReads === 2) return resolverGap
      return resolved
    })
    const deleteResource = vi.fn(async () => undefined)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string, drive: string) => affordanceProducer(id, drive)),
          deleteResource,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope,
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const resourceKey = [
      ...desktopQueryKeys.gfsRoot,
      sessionScope,
      'preview-resource',
      uri,
      { sessionGeneration: 1 },
    ] as const
    const affordanceKey = desktopQueryKeys.gfsAffordances(sessionScope, resourceId, 'main', 1)
    try {
      render(<PreviewWithToasts uriToPreview={uri} />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      })
      await screen.findByAltText('Preview of diagram.png')
      await waitFor(() => expect(resourceAffordanceReads).toBe(1))
      await waitFor(() => expect(queryClient.getQueryState(affordanceKey)?.status).toBe('success'))

      fireEvent.click(screen.getByRole('button', { name: 'Options for diagram.png' }))
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }))
      await screen.findByRole('dialog', { name: 'Delete diagram.png?' })

      const permissionRequest = queryClient.invalidateQueries({
        exact: true,
        queryKey: affordanceKey,
      })
      await waitFor(() => expect(resourceAffordanceReads).toBe(2))
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() =>
        expect(
          screen.getByRole('dialog', { name: 'Delete diagram.png?' }).getAttribute('aria-busy')
        ).toBe('true')
      )
      expect(queryClient.getQueryState(affordanceKey)?.fetchStatus).toBe('fetching')

      const resolverRefetch = queryClient.refetchQueries({ exact: true, queryKey: resourceKey })
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
      rejectResolver(resolverFailure)
      await resolverRefetch
      await waitFor(() => expect(queryClient.getQueryState(resourceKey)?.status).toBe('error'))
      expect(screen.queryByRole('dialog', { name: 'Delete diagram.png?' })).toBeNull()
      expect(queryClient.getQueryState(affordanceKey)?.fetchStatus).toBe('fetching')

      await act(async () => {
        releasePermissionRefetch(heldPermissionResponse(['read', 'write', 'delete']))
        await pendingPermissionResponse
      })
      await permissionRequest
      await waitFor(() => expect(queryClient.getQueryState(affordanceKey)?.status).toBe('success'))
      expect(resourceAffordanceReads).toBeGreaterThanOrEqual(2)
      expect(deleteResource).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog', { name: 'Delete diagram.png?' })).toBeNull()
      expect(screen.queryByText('Deleted diagram.png')).toBeNull()
    } finally {
      rejectResolver(resolverFailure)
      releasePermissionRefetch(heldPermissionResponse(['read', 'write', 'delete']))
      queryClient.clear()
    }
  })
})
