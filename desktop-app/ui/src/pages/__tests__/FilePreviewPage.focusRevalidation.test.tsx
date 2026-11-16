// @vitest-environment jsdom
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { isPermissionErrorAcknowledged } from '@components/Common/permissionErrorAcknowledgement'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useWindowFocusBridge } from '@hooks/useWindowFocusBridge'
import { gfsAuthorityRetryPauseRemainingMs } from '@lib/gfsAuthorityQueryPolicy'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
const permissionRetryCapture = vi.hoisted(() => ({
  current: null as null | {
    retry: () => { admitted: boolean; completion?: Promise<unknown> }
    error: import('@components/Common/PermissionErrorDialog/types').PermissionErrorItem
  },
}))
vi.mock('@components/Common', async importOriginal => {
  const common = await importOriginal<typeof import('@components/Common')>()
  const React = await import('react')
  return {
    ...common,
    PermissionErrorDialog: (props: Parameters<typeof common.PermissionErrorDialog>[0]) => {
      const error = props.errors.find(item => item.message.includes('move permissions'))
      permissionRetryCapture.current = error?.retry ? { retry: error.retry, error } : null
      return React.createElement(common.PermissionErrorDialog, props)
    },
  }
})

const resourceId = '0123456789abcdef0123456789abcdef'
const uri = `gfs://main/${resourceId}`

afterEach(() => {
  cleanup()
  permissionRetryCapture.current = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('FilePreviewPage focus revalidation', () => {
  it('rejects a stale preview Retry while another Preview retains its shared parent Query', async () => {
    const retainedResourceId = 'fedcba9876543210fedcba9876543210'
    const retainedUri = `gfs://main/${retainedResourceId}`
    const nextResourceId = 'abcdef0123456789abcdef0123456789'
    const nextUri = `gfs://main/${nextResourceId}`
    const sourceFailure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      'source-parent'
    )
    const sourceParentReads = vi.fn(async () => {
      throw sourceFailure
    })
    const resolve = vi.fn(async (requestedUri: string) => {
      const id =
        requestedUri === uri
          ? resourceId
          : requestedUri === retainedUri
            ? retainedResourceId
            : nextResourceId
      return resolveResource({
        resourceId: id,
        rid: id,
        gfsUri: requestedUri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn(async (id: string) =>
            id === 'source-parent'
              ? sourceParentReads()
              : heldPermissionResponse(['read', 'write', 'delete'])
          ),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-binding-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const sourceParentKey = desktopQueryKeys.gfsAffordances(
      'preview-binding-user:main',
      'source-parent',
      'main',
      1
    )
    function Previews({ changingUri }: { changingUri: string }) {
      return (
        <>
          <FilePreviewPage
            gfsUri={uri}
            fileName="diagram.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
          <FilePreviewPage
            gfsUri={changingUri}
            fileName="diagram.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        </>
      )
    }
    const view = render(<Previews changingUri={retainedUri} />, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    try {
      await waitFor(() =>
        expect(
          screen.getAllByRole('alertdialog', { name: 'Could not verify permissions' })
        ).toHaveLength(2)
      )
      await waitFor(() => expect(client.getQueryState(sourceParentKey)?.status).toBe('error'))
      const originalQuery = client.getQueryCache().find({ exact: true, queryKey: sourceParentKey })
      const retryBeforeNavigation = permissionRetryCapture.current
      expect(retryBeforeNavigation?.retry).toBeTypeOf('function')

      view.rerender(<Previews changingUri={nextUri} />)
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(nextUri))
      expect(client.getQueryCache().find({ exact: true, queryKey: sourceParentKey })).toBe(
        originalQuery
      )
      const producerCallsBeforeRetry = sourceParentReads.mock.calls.length

      let attempt: { admitted: boolean; completion?: Promise<unknown> } | undefined
      act(() => {
        attempt = retryBeforeNavigation?.retry()
      })
      expect(attempt?.admitted).toBe(false)
      expect(sourceParentReads).toHaveBeenCalledTimes(producerCallsBeforeRetry)
    } finally {
      client.clear()
    }
  })

  it('suppresses an admitted Retry outcome after the Preview resource binding changes', async () => {
    const nextResourceId = 'abcdef0123456789abcdef0123456789'
    const nextUri = `gfs://main/${nextResourceId}`
    const failure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      resourceId
    )
    let rejectRetry!: (error: Error) => void
    const retryProducer = new Promise<never>((_resolve, reject) => {
      rejectRetry = reject
    })
    const reads = vi.fn(async (id: string) => {
      if (id === resourceId && reads.mock.calls.length === 1) throw failure
      if (id === resourceId) return retryProducer
      return heldPermissionResponse(['read', 'write'])
    })
    const resolve = vi.fn(async (requestedUri: string) => {
      const id = requestedUri === uri ? resourceId : nextResourceId
      return resolveResource({
        resourceId: id,
        rid: id,
        gfsUri: requestedUri,
        drive: 'main',
        parentResourceId: 'source-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: reads,
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-binding-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const pushToast = vi.fn()
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const resourceKey = desktopQueryKeys.gfsAffordances(
      'preview-binding-user:main',
      resourceId,
      'main',
      1
    )
    const page = (requestedUri: string) => (
      <FilePreviewPage
        gfsUri={requestedUri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />
    )
    const view = render(page(uri), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    try {
      await screen.findByRole('alertdialog', { name: 'Could not verify permissions' })
      const retryButton = screen.getByRole('button', { name: 'Retry permission check' })
      fireEvent.click(retryButton)
      await waitFor(() => expect(client.getQueryState(resourceKey)?.fetchStatus).toBe('fetching'))

      view.rerender(page(nextUri))
      await waitFor(() => expect(resolve).toHaveBeenCalledWith(nextUri))
      await waitFor(() =>
        expect(
          client.getQueryState(
            desktopQueryKeys.gfsAffordances('preview-binding-user:main', nextResourceId, 'main', 1)
          )?.status
        ).toBe('success')
      )

      await act(async () => {
        rejectRetry(failure)
        await new Promise(resolveMicrotask => setTimeout(resolveMicrotask, 0))
      })
      expect(pushToast).not.toHaveBeenCalled()
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()
    } finally {
      client.clear()
    }
  })

  it('reopens every dismissed file and parent permission failure from the recovery cue', async () => {
    const fileFailure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      resourceId
    )
    const parentFailure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      'source-parent'
    )
    const resolverFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
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
    const affordances = appServiceAffordanceProducer(async id => {
      if (id === resourceId) throw fileFailure
      if (id === 'source-parent') throw parentFailure
      return heldPermissionResponse(['read'])
    })
    const resolve = vi.fn().mockResolvedValueOnce(resolved).mockRejectedValue(resolverFailure)
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string) => affordances(id)),
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
    const filePermissionKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      resourceId,
      'main',
      1
    )
    const parentPermissionKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    const resourceQueryKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-focus-user:main',
      'preview-resource',
      uri,
      { sessionGeneration: 1 },
    ]
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
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      await waitFor(() => {
        expect(queryClient.getQueryState(filePermissionKey)?.status).toBe('error')
        expect(queryClient.getQueryState(parentPermissionKey)?.status).toBe('error')
        expect(
          within(dialog).getAllByRole('button', { name: 'Retry permission check' })
        ).toHaveLength(2)
      })
      expect(dialog.textContent).toContain('Could not verify file permissions')
      expect(dialog.textContent).toContain('Could not verify move permissions')

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      await act(async () => {
        await queryClient.refetchQueries({ exact: true, queryKey: resourceQueryKey })
      })
      await waitFor(() => expect(queryClient.getQueryState(resourceQueryKey)?.status).toBe('error'))
      const cue = await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      fireEvent.click(cue)

      const recoveredDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(recoveredDialog.textContent).toContain('Could not verify file permissions')
      expect(recoveredDialog.textContent).toContain('Could not verify move permissions')
      expect(
        within(recoveredDialog).getAllByRole('button', { name: 'Retry permission check' })
      ).toHaveLength(2)
    } finally {
      queryClient.clear()
    }
  })

  it('keeps the dismissed Preview failure recoverable through a transient resolver error', async () => {
    const parentFailure = new Error(
      "Error invoking remote method 'gfs:affordances': 503 Unavailable httpStatus=503"
    )
    const resourceFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
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
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(resolved)
      .mockRejectedValueOnce(resourceFailure)
      .mockResolvedValue(resolved)
    const affordances = vi.fn(async (id: string) => {
      if (id === 'source-parent') throw parentFailure
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
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
    const parentPermissionKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    const resourceKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-focus-user:main',
      'preview-resource',
      uri,
      { sessionGeneration: 1 },
    ] as const
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
    try {
      render(<FocusAwarePreview />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      })
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(dialog.textContent).toContain('Could not verify move permissions')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })

      fireEvent.focus(window)
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(queryClient.getQueryState(resourceKey)?.status).toBe('error'))
      expect(queryClient.getQueryState(parentPermissionKey)?.status).toBe('error')
      const retainedRecoveryCue = screen.getByRole('button', {
        name: 'Permission check failed; open recovery options',
      })

      fireEvent.click(retainedRecoveryCue)
      const recoveredDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(recoveredDialog.textContent).toContain('Could not verify move permissions')
      const parentQuery = queryClient.getQueryCache().find({
        queryKey: parentPermissionKey,
        exact: true,
      })
      const errorUpdateCount = queryClient.getQueryState(parentPermissionKey)?.errorUpdateCount ?? 0
      const sourceRetryCount = affordances.mock.calls.filter(
        ([id]) => id === 'source-parent'
      ).length
      fireEvent.click(
        within(recoveredDialog).getByRole('button', { name: 'Retry permission check' })
      )
      await waitFor(() =>
        expect(affordances.mock.calls.filter(([id]) => id === 'source-parent').length).toBe(
          sourceRetryCount + 1
        )
      )
      expect(affordances).toHaveBeenLastCalledWith('source-parent', 'main')
      expect(queryClient.getQueryCache().find({ queryKey: parentPermissionKey, exact: true })).toBe(
        parentQuery
      )
      await waitFor(() =>
        expect(queryClient.getQueryState(parentPermissionKey)?.errorUpdateCount).toBeGreaterThan(
          errorUpdateCount
        )
      )
      expect(screen.getByRole('alertdialog')).toBeTruthy()
      expect(screen.getByText(/Could not verify move permissions/)).toBeTruthy()
    } finally {
      queryClient.clear()
    }
  })

  it('removes a retired Retry target before the next user input', async () => {
    const firstFailure = await affordancesApiError(
      429,
      { code: 'rate_limited', message: 'Too Many Requests' },
      'source-parent'
    )
    const replacementFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service unavailable' },
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
    const resolverFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
    const resolve = vi.fn().mockResolvedValueOnce(resolved).mockRejectedValue(resolverFailure)
    let parentReads = 0
    const affordances = appServiceAffordanceProducer(async id => {
      if (id === 'source-parent') {
        parentReads += 1
        if (parentReads === 1) throw firstFailure
        throw replacementFailure
      }
      return heldPermissionResponse(['read', 'write'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string) => affordances(id)),
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
    try {
      render(<FocusAwarePreview />, {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      })
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      const originalQuery = queryClient.getQueryCache().find({
        queryKey: parentPermissionKey,
        exact: true,
      })
      expect(originalQuery?.state.status).toBe('error')
      expect(parentReads).toBe(1)
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      fireEvent.focus(window)
      fireEvent.focus(window)
      await waitFor(() =>
        expect(
          queryClient.getQueryState([
            ...desktopQueryKeys.gfsRoot,
            'preview-focus-user:main',
            'preview-resource',
            uri,
            { sessionGeneration: 1 },
          ])?.status
        ).toBe('error')
      )
      await waitFor(() =>
        expect(
          queryClient.getQueryState([
            ...desktopQueryKeys.gfsRoot,
            'preview-focus-user:main',
            'preview-resource',
            uri,
            { sessionGeneration: 1 },
          ])?.fetchStatus
        ).toBe('idle')
      )
      fireEvent.click(
        screen.getByRole('button', { name: 'Permission check failed; open recovery options' })
      )
      const recoveredDialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(
        within(recoveredDialog).getByRole('button', { name: 'Retry permission check' })
      ).toBeTruthy()
      const resolveCallsBeforeReplacement = resolve.mock.calls.length

      const replacementData = await appServiceAffordanceProducer(() =>
        Promise.resolve(heldPermissionResponse(['read', 'write']))
      )('source-parent')
      let replacementQuery = originalQuery
      act(() => {
        queryClient.removeQueries({ exact: true, queryKey: parentPermissionKey })
        queryClient.setQueryData(parentPermissionKey, replacementData)
        queryClient.invalidateQueries({
          exact: true,
          queryKey: parentPermissionKey,
          refetchType: 'none',
        })
        replacementQuery = queryClient.getQueryCache().find({
          queryKey: parentPermissionKey,
          exact: true,
        })
        expect(replacementQuery).toBeDefined()
        expect(replacementQuery).not.toBe(originalQuery)
      })

      await waitFor(() => expect(parentReads).toBe(1))
      expect(resolve).toHaveBeenCalledTimes(resolveCallsBeforeReplacement)
      expect(replacementQuery?.state.status).toBe('success')
      expect(replacementQuery?.state.isInvalidated).toBe(true)
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
    } finally {
      queryClient.clear()
    }
  })

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
    let rejectAutomaticRefetch!: (error: Error) => void
    const automaticRefetch = new Promise<Awaited<ReturnType<typeof delegationAffordances>>>(
      (_resolve, reject) => {
        rejectAutomaticRefetch = reject
      }
    )
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
        if (sourceReads.length === 3) return automaticRefetch
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

    const sourceQueryKey = desktopQueryKeys.gfsAffordances(
      'preview-focus-user:main',
      'source-parent',
      'main',
      1
    )
    const sourceQueryState = queryClient.getQueryState(sourceQueryKey)
    expect(sourceQueryState?.error).toBe(limited)
    expect(
      gfsAuthorityRetryPauseRemainingMs(
        sourceQueryState?.error,
        sourceQueryState?.errorUpdatedAt ?? 0
      )
    ).toBeGreaterThan(0)
    let automaticRequest!: Promise<void>
    act(() => {
      automaticRequest = queryClient.refetchQueries({ exact: true, queryKey: sourceQueryKey })
      expect(queryClient.getQueryState(sourceQueryKey)?.fetchStatus).toBe('fetching')
      expect(screen.getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))
      expect(sourceReads).toHaveLength(3)
      const retryQuery = queryClient.getQueryCache().find({ queryKey: sourceQueryKey, exact: true })
      expect(
        isPermissionErrorAcknowledged({
          id: 'source-parent-retry',
          message: 'Too many file requests',
          queryIdentity: retryQuery,
          errorUpdateCount: retryQuery?.state.errorUpdateCount,
        })
      ).toBe(false)
    })
    await act(async () => {
      rejectAutomaticRefetch(limited)
      await automaticRequest
    })
    expect(screen.getByText(/Too many file requests/)).toBeTruthy()

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
    expect(sourceReads).toHaveLength(4)
    expect(screen.queryByText(/Too many file requests/)).toBeNull()
    queryClient.clear()
  })

  it('suppresses the old Preview recovery UI in the same commit after terminal resolver denial', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'upstream_unavailable', message: 'permission service unavailable' },
      'source-parent'
    )
    const resolverDenied = Object.assign(new Error('404 Not Found'), { httpStatus: 404 })
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
    const resolve = vi.fn().mockResolvedValueOnce(resolved).mockRejectedValue(resolverDenied)
    const affordances = vi.fn(async (id: string) => {
      if (id === 'source-parent') throw parentFailure
      return delegationAffordances(new Set(['read', 'write', 'delete']), false)
    })
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

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Could not verify permissions',
    })
    expect(dialog.textContent).toContain('Could not verify move permissions')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await screen.findByRole('button', {
      name: 'Permission check failed; open recovery options',
    })

    const stalePermissionDialogInsertions: Element[] = []
    const dialogObserver = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          const dialogs = [
            ...(node.matches('[role="alertdialog"]') ? [node] : []),
            ...node.querySelectorAll<HTMLElement>('[role="alertdialog"]'),
          ]
          stalePermissionDialogInsertions.push(
            ...dialogs.filter(dialog =>
              dialog.textContent?.includes('Could not verify move permissions')
            )
          )
        }
      }
    })
    dialogObserver.observe(document.body, { childList: true, subtree: true })

    fireEvent.focus(window)
    await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .some(query => query.state.error === resolverDenied)
    ).toBe(true)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
      ).toBeNull()
    )
    await waitFor(() =>
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()
    )
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
    dialogObserver.disconnect()
    expect(stalePermissionDialogInsertions).toHaveLength(0)
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
