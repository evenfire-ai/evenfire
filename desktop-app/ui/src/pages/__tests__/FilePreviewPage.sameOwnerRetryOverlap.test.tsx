// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
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
const sessionScope = 'c1c4-focus-retry-user:main'

function FocusAwarePreview() {
  const toast = useToastController()
  useWindowFocusBridge()
  return (
    <>
      <FilePreviewPage
        gfsUri={uri}
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
  focusManager.setFocused(undefined)
  vi.restoreAllMocks()
})

describe('C1c4 real Preview Retry and window-focus overlap', () => {
  it('keeps the Retry control reachable and publishes one terminal event and one toast', async () => {
    const failure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service temporarily unavailable' },
      resourceId
    )
    let rejectRetry!: (error: Error) => void
    const retryPending = new Promise<never>((_resolve, reject) => {
      rejectRetry = reject
    })
    const resourceReads = vi.fn(async () => {
      if (resourceReads.mock.calls.length === 1) throw failure
      return retryPending
    })
    const affordances = appServiceAffordanceProducer(async id => {
      if (id === resourceId) return resourceReads()
      return heldPermissionResponse(['read', 'write', 'delete'])
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
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: vi.fn(async () => resolved),
          affordances: vi.fn((id: string) => affordances(id)),
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
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const resourceKey = desktopQueryKeys.gfsAffordances(sessionScope, resourceId, 'main', 1)
    let terminalErrors = 0
    const stop = client.getQueryCache().subscribe(event => {
      if (
        event.type === 'updated' &&
        event.action.type === 'error' &&
        event.query.queryHash ===
          client.getQueryCache().find({ exact: true, queryKey: resourceKey })?.queryHash
      )
        terminalErrors += 1
    })
    try {
      render(<FocusAwarePreview />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      })
      const firstDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(
        within(firstDialog).getByRole('button', { name: 'Retry permission check' })
      ).toBeTruthy()
      const query = client.getQueryCache().find({ exact: true, queryKey: resourceKey })
      expect(query).toBeTruthy()
      expect(resourceReads).toHaveBeenCalledTimes(1)
      const terminalErrorsBeforeRetry = terminalErrors

      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Retry permission check' }))
      await waitFor(() => expect(query?.state.fetchStatus).toBe('fetching'))
      expect(resourceReads).toHaveBeenCalledTimes(2)
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()

      act(() => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => expect(query?.state.fetchStatus).toBe('fetching'))
      expect(resourceReads).toHaveBeenCalledTimes(2)

      fireEvent.click(
        screen.getByRole('button', { name: 'Permission check failed; open recovery options' })
      )
      const dialogDuringFocus = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      const retryButtonDuringFocus = within(dialogDuringFocus).getByRole('button', {
        name: 'Retry permission check',
      })
      expect(retryButtonDuringFocus).toBeTruthy()
      fireEvent.click(retryButtonDuringFocus)
      await waitFor(() => expect(query?.state.fetchStatus).toBe('fetching'))
      expect(screen.getByRole('alertdialog', { name: 'Could not verify permissions' })).toBeTruthy()
      expect(resourceReads).toHaveBeenCalledTimes(2)

      await act(async () => {
        rejectRetry(failure)
        await retryPending.catch(() => undefined)
      })
      await waitFor(() => expect(query?.state.errorUpdateCount).toBe(2))
      await waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(
          'permission service temporarily unavailable'
        )
      )
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getAllByRole('alertdialog')).toHaveLength(1)
      expect(terminalErrors - terminalErrorsBeforeRetry).toBe(1)
      expect(client.getQueryCache().find({ exact: true, queryKey: resourceKey })).toBe(query)
      expect(query?.state.fetchStatus).toBe('idle')
      expect(resourceReads).toHaveBeenCalledTimes(2)
    } finally {
      stop()
      rejectRetry(failure)
      client.clear()
    }
  })
})
