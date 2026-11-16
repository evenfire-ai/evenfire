// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import { appServiceAffordanceProducer } from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '1234567890abcdef1234567890abcdef'
const uri = `gfs://main/${resourceId}`
const scope = 'preview-r3m6-remount:main'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('R3-M6 terminal resolver denial after Preview remount', () => {
  it('suppresses a retained file permission error after the real resolver remount refetch denies access', async () => {
    const resolved = await resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: uri,
      drive: 'main',
      parentResourceId: resourceId,
      name: 'diagram.png',
      kind: 'file',
      version: 1,
      bytes: 1,
    })
    const denied = Object.assign(new Error('404 Not Found'), { httpStatus: 404 })
    let rejectResolver!: (error: Error) => void
    const pendingResolver = new Promise<never>((_resolve, reject) => {
      rejectResolver = reject
    })
    let resolveCalls = 0
    const resolve = vi.fn(async () => {
      resolveCalls += 1
      if (resolveCalls === 1) return resolved
      if (resolveCalls === 2) return pendingResolver
      return resolved
    })
    const failure = Object.assign(new Error('503 Unavailable'), { httpStatus: 503 })
    const affordances = appServiceAffordanceProducer(async () => {
      throw failure
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
      sessionScope: scope,
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
    })
    const resourceKey = [
      ...desktopQueryKeys.gfsRoot,
      scope,
      'preview-resource',
      uri,
      { sessionGeneration: 1 },
    ] as const
    const permissionKey = desktopQueryKeys.gfsAffordances(scope, resourceId, 'main', 1)
    const page = () => (
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
      />
    )
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    )
    const first = render(page(), { wrapper })
    try {
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(within(dialog).getByText(/Could not verify file permissions/)).toBeTruthy()
      const close = within(dialog).getByRole('button', { name: 'Close' })
      fireEvent.click(close)
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
      await screen.findByRole('button', { name: 'Permission check failed; open recovery options' })
      first.unmount()
      expect(client.getQueryState(resourceKey)?.data).toEqual(resolved)
      expect(client.getQueryState(permissionKey)?.status).toBe('error')

      const second = render(page(), { wrapper })
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(client.getQueryState(resourceKey)?.fetchStatus).toBe('fetching'))
      expect(
        screen.getByRole('button', { name: 'Permission check failed; open recovery options' })
      ).toBeTruthy()
      await act(async () => rejectResolver(denied))
      await waitFor(() => expect(client.getQueryState(resourceKey)?.status).toBe('error'))
      expect(client.getQueryCache().find({ queryKey: resourceKey, exact: true })?.state.error).toBe(
        denied
      )
      expect(client.getQueryState(permissionKey)?.status).toBe('error')
      expect(
        screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
      ).toBeNull()
      expect(screen.queryByRole('alertdialog', { name: 'Could not verify permissions' })).toBeNull()
      second.unmount()
      rejectResolver(denied)
    } finally {
      client.clear()
    }
  })
})
