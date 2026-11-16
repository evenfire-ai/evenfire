// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const resourceId = '1234567890abcdef1234567890abcdef'
const uri = `gfs://main/${resourceId}`

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FilePreviewPage Query removal lifecycle', () => {
  it('releases the production Preview owner after its exact permission Query is removed', async context => {
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc
    if (!collectGarbage) return context.skip()

    const scope = 'preview-lifecycle-user:main'
    let resource: Awaited<ReturnType<typeof resolveResource>> | undefined = await resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'parent-lifecycle',
      name: 'lifecycle.png',
      kind: 'file',
      version: 1,
      bytes: 1,
    })
    const producer = appServiceAffordanceProducer(async () =>
      heldPermissionResponse(['read', 'write', 'delete'])
    )
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve: async () => {
            if (!resource) throw new Error('Preview resource fixture was released')
            return resource
          },
          affordances: vi.fn((id: string) => producer(id)),
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
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const queryKey = desktopQueryKeys.gfsAffordances(scope, resourceId, 'main', 1)
    let query = client.getQueryCache().find({ queryKey, exact: true }) ?? null
    let unmount: (() => void) | undefined
    let reference: WeakRef<object> | undefined
    let resourceReference: WeakRef<object> | undefined
    try {
      unmount = render(
        <FilePreviewPage
          gfsUri={uri}
          fileName="lifecycle.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />,
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          ),
        }
      ).unmount
      expect(await screen.findByAltText('Preview of lifecycle.png')).toBeTruthy()
      resourceReference = new WeakRef(resource as object)
      await waitFor(() => {
        query = client.getQueryCache().find({ queryKey, exact: true }) ?? null
        expect(query?.state.status).toBe('success')
      })
      expect(query?.getObserversCount()).toBeGreaterThan(0)
      reference = new WeakRef(query as object)
      const queryHash = query?.queryHash
      if (!queryHash) throw new Error('Expected the production Preview Query hash')
      let removedQueryHash: string | null = null
      const stopTracking = client.getQueryCache().subscribe(event => {
        if (event.type === 'removed' && event.query.queryHash === queryHash) {
          removedQueryHash = event.query.queryHash
        }
      })

      unmount?.()
      unmount = undefined
      expect(query?.getObserversCount()).toBe(0)
      await waitFor(() => {
        expect(removedQueryHash).toBe(queryHash)
        expect(client.getQueryCache().find({ queryKey, exact: true })).toBeUndefined()
      })
      stopTracking()
      query = null
      client.clear()
      resource = undefined

      for (let attempt = 0; attempt < 12; attempt += 1) {
        collectGarbage()
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(resourceReference).toBeDefined()
      expect(resourceReference!.deref()).toBeUndefined()
      expect(reference).toBeDefined()
      expect(reference!.deref()).toBeUndefined()
    } finally {
      unmount?.()
      client.clear()
    }
  })
})
