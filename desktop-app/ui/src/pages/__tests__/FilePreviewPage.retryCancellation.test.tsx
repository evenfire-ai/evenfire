// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, onlineManager, useQuery } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { permissionErrorToken } from '@components/Common/permissionErrorAcknowledgement'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
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
const sessionScope = 'preview-focus-user:main'

function ToastingPreview({
  queryClient,
  previewUri = uri,
}: {
  queryClient: QueryClient
  previewUri?: string
}) {
  const toast = useToastController()
  return (
    <QueryClientProvider client={queryClient}>
      <FilePreviewPage
        gfsUri={previewUri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={toast.pushToast}
      />
      <ToastStack items={toast.toasts} onDismiss={toast.dismissToast} />
    </QueryClientProvider>
  )
}

function ParentPermissionObserver() {
  useQuery({
    queryKey: desktopQueryKeys.gfsAffordances(sessionScope, 'source-parent', 'main', 1),
    queryFn: () => window.clerum.gfs.affordances('source-parent', 'main'),
    retry: false,
    networkMode: 'online',
  })
  return null
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  onlineManager.setOnline(true)
})

describe('Preview Retry cancellation and observer ownership', () => {
  it('settles an offline no-data Retry neutrally when Preview unmount removes its last observer', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
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
    let parentReads = 0
    const produceAffordances = appServiceAffordanceProducer(async id => {
      if (id === 'source-parent') {
        parentReads += 1
        throw parentFailure
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resolved),
          affordances: vi.fn((id: string, drive: string) => produceAffordances(id, drive)),
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
    const parentKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    try {
      const view = render(<ToastingPreview queryClient={queryClient} />)
      const initialDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close' }))
      const cue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      const permissionQuery = queryClient.getQueryCache().find({ queryKey: parentKey, exact: true })
      if (!permissionQuery) throw new Error('Expected the real parent permission Query')

      onlineManager.setOnline(false)
      fireEvent.click(cue)
      const retryDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(retryDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => {
        expect(permissionQuery.state.status).toBe('pending')
        expect(permissionQuery.state.fetchStatus).toBe('paused')
      })
      const readsBeforePausedRetry = parentReads
      view.unmount()
      await waitFor(() => expect(permissionQuery.getObserversCount()).toBe(0))
      await waitFor(() => expect(permissionQuery.state.fetchStatus).toBe('idle'))
      expect(permissionQuery.state.status).toBe('error')
      expect(parentReads).toBe(readsBeforePausedRetry)
      expect(document.querySelector('.toast-body')).toBeNull()

      render(<ToastingPreview queryClient={queryClient} />)
      await screen.findByAltText('Preview of diagram.png')
      expect(
        await screen.findByRole('button', {
          name: 'Permission check failed; open recovery options',
        })
      ).toBeTruthy()
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()
    } finally {
      onlineManager.setOnline(true)
      queryClient.clear()
    }
  })

  it('keeps a paused Retry pending under a shared Query observer until the producer fails', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
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
    let parentReads = 0
    const produceAffordances = appServiceAffordanceProducer(async id => {
      if (id === 'source-parent') {
        parentReads += 1
        throw parentFailure
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resolved),
          affordances: vi.fn((id: string, drive: string) => produceAffordances(id, drive)),
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
    const parentKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    try {
      const view = render(<ToastingPreview queryClient={queryClient} />)
      const initialDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close' }))
      const cue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      const permissionQuery = queryClient.getQueryCache().find({ queryKey: parentKey, exact: true })
      if (!permissionQuery) throw new Error('Expected the real shared parent permission Query')
      const originalFailureToken = permissionErrorToken({
        id: 'preview-parent-retry',
        message: 'Could not verify Move permissions for source-parent.',
        queryIdentity: permissionQuery,
      })
      expect(originalFailureToken).toBeTruthy()
      render(
        <QueryClientProvider client={queryClient}>
          <ParentPermissionObserver />
        </QueryClientProvider>
      )
      await waitFor(() => expect(permissionQuery.getObserversCount()).toBe(2))

      onlineManager.setOnline(false)
      fireEvent.click(cue)
      const retryDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(retryDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(permissionQuery.state.fetchStatus).toBe('paused'))
      const readsBeforeRetry = parentReads
      view.unmount()
      await waitFor(() => expect(permissionQuery.getObserversCount()).toBe(1))
      expect(permissionQuery.state.fetchStatus).toBe('paused')
      expect(parentReads).toBe(readsBeforeRetry)
      expect(document.querySelector('.toast-body')).toBeNull()

      onlineManager.setOnline(true)
      await waitFor(() => expect(permissionQuery.state.status).toBe('error'))
      expect(parentReads).toBe(readsBeforeRetry + 1)
      expect(
        permissionErrorToken({
          id: 'preview-parent-retry',
          message: 'Could not verify Move permissions for source-parent.',
          queryIdentity: permissionQuery,
        })
      ).not.toBe(originalFailureToken)
      expect(document.querySelector('.toast-body')).toBeNull()
      render(<ToastingPreview queryClient={queryClient} />)
      await screen.findByAltText('Preview of diagram.png')
      const returnedCue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      fireEvent.click(returnedCue)
      expect(
        await screen.findByRole('alertdialog', { name: 'Could not verify permissions' })
      ).toBeTruthy()
    } finally {
      onlineManager.setOnline(true)
      queryClient.clear()
    }
  })

  it('keeps a started no-signal Retry alive across a resolver gap until its producer settles', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const otherUri = 'gfs://main/fedcba9876543210fedcba9876543210'
    const otherFailure = Object.assign(new Error('preview resolver temporarily unavailable'), {
      httpStatus: 503,
    })
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
    let releaseRetry!: (value: Awaited<ReturnType<typeof heldPermissionResponse>>) => void
    let rejectRetry!: (error: Error) => void
    const retryRequest = new Promise<Awaited<ReturnType<typeof heldPermissionResponse>>>(
      (resolve, reject) => {
        releaseRetry = resolve
        rejectRetry = reject
      }
    )
    void retryRequest.catch(() => undefined)
    let parentReads = 0
    const produceAffordances = appServiceAffordanceProducer(async id => {
      if (id !== 'source-parent') return heldPermissionResponse(['read', 'write', 'delete'])
      parentReads += 1
      if (parentReads === 2) return retryRequest
      if (parentReads > 2) throw parentFailure
      throw parentFailure
    })
    const resolve = vi.fn(async (requestedUri: string) => {
      if (requestedUri === otherUri) throw otherFailure
      return resolved
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string, drive: string) => produceAffordances(id, drive)),
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
    const parentKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    const otherResourceKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-focus-user:main',
      'preview-resource',
      otherUri,
      { sessionGeneration: 1 },
    ] as const
    const renderPreview = (previewUri: string) => (
      <ToastingPreview queryClient={queryClient} previewUri={previewUri} />
    )
    try {
      const view = render(renderPreview(uri))
      const initialDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close' }))
      const cue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      const permissionQuery = queryClient.getQueryCache().find({ queryKey: parentKey, exact: true })
      if (!permissionQuery) throw new Error('Expected the real parent permission Query')
      const originalFailureToken = permissionErrorToken({
        id: 'preview-parent-retry',
        message: 'Could not verify Move permissions for source-parent.',
        queryIdentity: permissionQuery,
      })
      expect(originalFailureToken).toBeTruthy()
      fireEvent.click(cue)
      const retryDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      fireEvent.click(within(retryDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(parentReads).toBe(2))
      expect(permissionQuery.state.fetchStatus).toBe('fetching')

      view.rerender(renderPreview(otherUri))
      await waitFor(() => expect(queryClient.getQueryState(otherResourceKey)?.status).toBe('error'))
      await waitFor(() => expect(permissionQuery.getObserversCount()).toBe(0))
      expect(permissionQuery.state.fetchStatus).toBe('fetching')
      await act(async () => {
        rejectRetry(parentFailure)
        await retryRequest.catch(() => undefined)
      })
      await waitFor(() => expect(permissionQuery.state.status).toBe('error'))
      expect(permissionQuery.state.errorUpdateCount).toBeGreaterThan(1)
      expect(
        permissionErrorToken({
          id: 'preview-parent-retry',
          message: 'Could not verify Move permissions for source-parent.',
          queryIdentity: permissionQuery,
        })
      ).not.toBe(originalFailureToken)
      expect(document.querySelector('.toast-body')).toBeNull()

      view.rerender(renderPreview(uri))
      await screen.findByAltText('Preview of diagram.png')
      const returnedCue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      fireEvent.click(returnedCue)
      expect(
        await screen.findByRole('alertdialog', { name: 'Could not verify permissions' })
      ).toBeTruthy()
    } finally {
      releaseRetry(heldPermissionResponse(['read', 'write', 'delete']))
      queryClient.clear()
    }
  })
})
