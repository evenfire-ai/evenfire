// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import fc, { type AsyncCommand } from 'fast-check'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { resolveResource } from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  affordancesApiError,
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))
vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)

const originalResourceId = '0123456789abcdef0123456789abcdef'
const originalUri = `gfs://main/${originalResourceId}`

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('FilePreviewPage resolver-context retention', () => {
  it('generates Preview resolver-gap, origin return, dismissal, and remount commands', async () => {
    type Model = {
      location: 'A' | 'B'
      acknowledged: boolean
      resolverGap: boolean
      recoveryRequested: boolean
    }
    type Real = {
      client: QueryClient
      originalResourceKey: readonly unknown[]
      navigate: (uri: string) => Promise<void>
      refetchOriginal: () => Promise<void>
      remountOrigin: () => Promise<void>
      hasCue: () => boolean
    }

    class DismissOriginFailure implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return !model.acknowledged && model.location === 'A'
      }
      async run(model: Model): Promise<void> {
        const dialog = await screen.findByRole('alertdialog', {
          name: 'Could not verify permissions',
        })
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
        await screen.findByRole('button', {
          name: 'Permission check failed; open recovery options',
        })
        model.acknowledged = true
      }
      toString(): string {
        return 'dismiss the real Preview permission dialog and keep its recovery cue'
      }
    }

    class ResolverGap implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.location === 'A' && model.acknowledged && !model.resolverGap
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.refetchOriginal()
        model.resolverGap = true
        expect(state.client.getQueryState(state.originalResourceKey)?.status).toBe('error')
        expect(state.hasCue()).toBe(true)
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'enter a real resolver gap while the dismissed permission Query remains current'
      }
    }

    class SwitchToB implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.location === 'A'
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.navigate(otherUri)
        model.location = 'B'
        expect(screen.getByAltText('Preview of diagram.png')).toBeTruthy()
        expect(state.hasCue()).toBe(false)
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'switch to B without projecting A permission recovery UI'
      }
    }

    class ReturnToA implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.location === 'B' && model.acknowledged
      }
      async run(model: Model, state: Real): Promise<void> {
        await state.navigate(originalUri)
        model.location = 'A'
        await screen.findByRole('button', {
          name: 'Permission check failed; open recovery options',
        })
        expect(state.client.getQueryState(state.originalResourceKey)?.status).toBe('error')
        expect(screen.queryByRole('alertdialog')).toBeNull()
      }
      toString(): string {
        return 'return to exact A and restore only its cue until the user opens recovery'
      }
    }

    class OpenRecovery implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.location === 'A' && model.acknowledged && !model.recoveryRequested
      }
      async run(model: Model): Promise<void> {
        fireEvent.click(
          screen.getByRole('button', { name: 'Permission check failed; open recovery options' })
        )
        await screen.findByRole('alertdialog', { name: 'Could not verify permissions' })
        model.recoveryRequested = true
      }
      toString(): string {
        return 'open the retained Preview recovery path after returning to A'
      }
    }

    class RemountOrigin implements AsyncCommand<Model, Real, true> {
      async check(model: Readonly<Model>): Promise<boolean> {
        return model.location === 'A' && model.acknowledged && !model.recoveryRequested
      }
      async run(_model: Model, state: Real): Promise<void> {
        await state.remountOrigin()
        expect(state.client.getQueryState(state.originalResourceKey)?.status).toBe('error')
        expect(state.hasCue()).toBe(true)
      }
      toString(): string {
        return 'remount A and preserve the exact Query recovery cue'
      }
    }

    const otherResourceId = 'fedcba9876543210fedcba9876543210'
    const otherUri = `gfs://main/${otherResourceId}`
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const resolverFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
    const previewResource = (requestedUri: string, id: string) =>
      resolveResource({
        resourceId: id,
        rid: id,
        gfsUri: requestedUri,
        drive: 'main',
        parentResourceId: id === originalResourceId ? 'source-parent' : 'other-parent',
        name: 'diagram.png',
        kind: 'file',
        version: 7,
        bytes: 1,
      })
    let originalUriResolutions = 0
    const resolve = vi.fn(async (requestedUri: string) => {
      if (requestedUri === originalUri) {
        originalUriResolutions += 1
        if (originalUriResolutions > 1) throw resolverFailure
        return previewResource(originalUri, originalResourceId)
      }
      return previewResource(otherUri, otherResourceId)
    })
    const produceAffordances = appServiceAffordanceProducer(async (id: string) => {
      if (id === 'source-parent') throw parentFailure
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string) => produceAffordances(id)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-a6-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const originalResourceKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-a6-user:main',
      'preview-resource',
      originalUri,
      { sessionGeneration: 1 },
    ] as const
    let view: { unmount: () => void; rerender: (node: ReactNode) => void } | undefined
    let activeUri = originalUri
    const renderPreview = () => (
      <QueryClientProvider client={client}>
        <FilePreviewPage
          key={activeUri}
          gfsUri={activeUri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      </QueryClientProvider>
    )
    const commands = fc.commands<Model, Real, true>(
      [
        fc.constant(new DismissOriginFailure()),
        fc.constant(new ResolverGap()),
        fc.constant(new SwitchToB()),
        fc.constant(new ReturnToA()),
        fc.constant(new OpenRecovery()),
        fc.constant(new RemountOrigin()),
      ],
      { maxCommands: 8 }
    )

    try {
      await fc.assert(
        fc.asyncProperty(commands, async scheduled => {
          view?.unmount()
          client.clear()
          originalUriResolutions = 0
          activeUri = originalUri
          view = render(renderPreview())
          const dialog = await screen.findByRole('alertdialog', {
            name: 'Could not verify permissions',
          })
          expect(dialog.textContent).toContain('Could not verify move permissions')
          const state: Real = {
            client,
            originalResourceKey,
            navigate: async uri => {
              activeUri = uri
              view?.rerender(renderPreview())
              if (uri === originalUri) {
                await screen.findByRole('button', {
                  name: 'Permission check failed; open recovery options',
                })
              } else {
                await screen.findByAltText('Preview of diagram.png')
              }
            },
            refetchOriginal: async () => {
              await act(async () => {
                await client.refetchQueries({ exact: true, queryKey: originalResourceKey })
              })
            },
            remountOrigin: async () => {
              view?.unmount()
              await act(async () => Promise.resolve())
              activeUri = originalUri
              view = render(renderPreview())
              await screen.findByRole('button', {
                name: 'Permission check failed; open recovery options',
              })
            },
            hasCue: () =>
              Boolean(
                screen.queryByRole('button', {
                  name: 'Permission check failed; open recovery options',
                })
              ),
          }
          const model: Model = {
            location: 'A',
            acknowledged: false,
            resolverGap: false,
            recoveryRequested: false,
          }
          await fc.asyncModelRun(() => ({ model, real: state }), scheduled)
          if (model.location === 'A' && model.acknowledged && !model.recoveryRequested) {
            expect(state.hasCue()).toBe(true)
            expect(screen.queryByRole('alertdialog')).toBeNull()
          }
        }),
        { numRuns: 24, seed: 142717 }
      )
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it.each(['successful resolution', 'terminal resolver denial'] as const)(
    'retains a dismissed Preview recovery context across A to B to A tab changes (%s)',
    async otherOutcome => {
      const otherResourceId = 'fedcba9876543210fedcba9876543210'
      const otherUri = `gfs://main/${otherResourceId}`
      const parentFailure = await affordancesApiError(
        503,
        { code: 'unavailable', message: 'permission service temporarily unavailable' },
        'source-parent'
      )
      const resolverFailure = new Error('preview resolver temporarily unavailable httpStatus=503')
      const otherResolverDenied = Object.assign(new Error('404 Not Found'), { httpStatus: 404 })
      const previewResource = (requestedUri: string, id: string) =>
        resolveResource({
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
      let originalUriResolutions = 0
      const resolve = vi.fn(async (requestedUri: string) => {
        if (requestedUri === originalUri) {
          originalUriResolutions += 1
          if (originalUriResolutions > 1) throw resolverFailure
          return previewResource(originalUri, originalResourceId)
        }
        if (otherOutcome === 'terminal resolver denial') throw otherResolverDenied
        return previewResource(otherUri, otherResourceId)
      })
      const resolveHeld = vi.fn(async (id: string) => {
        if (id === 'source-parent') throw parentFailure
        return heldPermissionResponse(['read', 'write', 'delete'])
      })
      const produceAffordances = appServiceAffordanceProducer(id => resolveHeld(id))
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          gfs: {
            resolve,
            affordances: vi.fn((id: string) => produceAffordances(id)),
            downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
          },
        },
      })
      hookMock.useGfsBrowserController.mockReturnValue({
        accessState: 'active',
        sessionScope: 'preview-tabs-user:main',
        sessionGeneration: 1,
        authorityPending: false,
        handleAuthorityFailure: vi.fn(() => false),
      })
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      const renderPreview = (activeUri: string) => (
        <QueryClientProvider client={queryClient}>
          <FilePreviewPage
            key={activeUri}
            gfsUri={activeUri}
            fileName="diagram.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        </QueryClientProvider>
      )
      const originalResourceKey = [
        ...desktopQueryKeys.gfsRoot,
        'preview-tabs-user:main',
        'preview-resource',
        originalUri,
        { sessionGeneration: 1 },
      ] as const
      try {
        const view = render(renderPreview(originalUri))
        const initialDialog = await screen.findByRole('alertdialog', {
          name: 'Could not verify permissions',
        })
        expect(initialDialog.textContent).toContain('Could not verify move permissions')
        fireEvent.click(within(initialDialog).getByRole('button', { name: 'Close' }))
        await screen.findByRole('button', {
          name: 'Permission check failed; open recovery options',
        })
        await act(async () => {
          await queryClient.refetchQueries({ exact: true, queryKey: originalResourceKey })
        })
        await waitFor(() =>
          expect(queryClient.getQueryState(originalResourceKey)?.status).toBe('error')
        )

        view.rerender(renderPreview(otherUri))
        if (otherOutcome === 'successful resolution') {
          expect(await screen.findByAltText('Preview of diagram.png')).toBeTruthy()
        } else {
          const otherResourceKey = [
            ...desktopQueryKeys.gfsRoot,
            'preview-tabs-user:main',
            'preview-resource',
            otherUri,
            { sessionGeneration: 1 },
          ] as const
          await waitFor(() =>
            expect(queryClient.getQueryState(otherResourceKey)?.status).toBe('error')
          )
        }

        view.rerender(renderPreview(originalUri))
        await waitFor(() => expect(originalUriResolutions).toBe(3))
        await waitFor(() =>
          expect(queryClient.getQueryState(originalResourceKey)?.status).toBe('error')
        )
        const cue = await screen.findByRole('button', {
          name: 'Permission check failed; open recovery options',
        })
        fireEvent.click(cue)
        const recoveredDialog = await screen.findByRole('alertdialog', {
          name: 'Could not verify permissions',
        })
        expect(recoveredDialog.textContent).toContain('Could not verify move permissions')
      } finally {
        queryClient.clear()
      }
    }
  )

  it('retires the old recovery cue when a remounted Preview resolver is terminally denied', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const resolverDenied = Object.assign(new Error('404 Not Found'), { httpStatus: 404 })
    const resolved = resolveResource({
      resourceId: originalResourceId,
      rid: originalResourceId,
      gfsUri: originalUri,
      drive: 'main',
      parentResourceId: 'source-parent',
      name: 'diagram.png',
      kind: 'file',
      version: 7,
      bytes: 1,
    })
    let resolutions = 0
    const resolve = vi.fn(async () => {
      resolutions += 1
      if (resolutions > 1) throw resolverDenied
      return resolved
    })
    const produceAffordances = appServiceAffordanceProducer(async (id: string) => {
      if (id === 'source-parent') throw parentFailure
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string) => produceAffordances(id)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-remount-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const resourceKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-remount-user:main',
      'preview-resource',
      originalUri,
      { sessionGeneration: 1 },
    ] as const
    const preview = () => (
      <QueryClientProvider client={client}>
        <FilePreviewPage
          gfsUri={originalUri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    try {
      view = render(preview())
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(dialog.textContent).toContain('Could not verify move permissions')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      view.unmount()
      await waitFor(() =>
        expect(
          client.getQueryCache().find({ exact: true, queryKey: resourceKey })?.getObserversCount()
        ).toBe(0)
      )

      view = render(preview())
      await waitFor(() => expect(resolutions).toBe(2))
      await waitFor(() => expect(client.getQueryState(resourceKey)?.status).toBe('error'))
      expect(screen.queryByRole('alertdialog')).toBeNull()
      expect(
        screen.queryByRole('button', { name: 'Permission check failed; open recovery options' })
      ).toBeNull()
    } finally {
      view?.unmount()
      client.clear()
    }
  })

  it('suppresses old recovery UI when a second same-Query Preview gets terminal denial', async () => {
    const parentFailure = await affordancesApiError(
      503,
      { code: 'unavailable', message: 'permission service temporarily unavailable' },
      'source-parent'
    )
    const resolverDenied = Object.assign(new Error('404 Not Found'), { httpStatus: 404 })
    const resolved = resolveResource({
      resourceId: originalResourceId,
      rid: originalResourceId,
      gfsUri: originalUri,
      drive: 'main',
      parentResourceId: 'source-parent',
      name: 'diagram.png',
      kind: 'file',
      version: 7,
      bytes: 1,
    })
    let resolutions = 0
    const resolve = vi.fn(async () => {
      resolutions += 1
      if (resolutions > 1) throw resolverDenied
      return resolved
    })
    const produceAffordances = appServiceAffordanceProducer(async (id: string) => {
      if (id === 'source-parent') throw parentFailure
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        gfs: {
          resolve,
          affordances: vi.fn((id: string) => produceAffordances(id)),
          downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        },
      },
    })
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-shared-query-user:main',
      sessionGeneration: 1,
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const resourceKey = [
      ...desktopQueryKeys.gfsRoot,
      'preview-shared-query-user:main',
      'preview-resource',
      originalUri,
      { sessionGeneration: 1 },
    ] as const
    const preview = (includeSecond: boolean) => (
      <QueryClientProvider client={client}>
        <FilePreviewPage
          key="first-preview"
          gfsUri={originalUri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
        {includeSecond && (
          <FilePreviewPage
            key="second-preview"
            gfsUri={originalUri}
            fileName="diagram.png"
            fileKind="image"
            mimeType="image/png"
            byteLength={1}
          />
        )}
      </QueryClientProvider>
    )
    let view: ReturnType<typeof render> | undefined
    try {
      view = render(preview(false))
      const dialog = await screen.findByRole('alertdialog', {
        name: 'Could not verify permissions',
      })
      expect(dialog.textContent).toContain('Could not verify move permissions')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      await screen.findByRole('button', {
        name: 'Permission check failed; open recovery options',
      })
      const stalePresentationInsertions: Element[] = []
      const observer = new MutationObserver(records => {
        if (client.getQueryState(resourceKey)?.status !== 'error') return
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!(node instanceof HTMLElement)) continue
            const candidates = [
              ...(node.matches('[role="alertdialog"]') ||
              node.matches('[aria-label="Permission check failed; open recovery options"]')
                ? [node]
                : []),
              ...node.querySelectorAll<HTMLElement>(
                '[role="alertdialog"], [aria-label="Permission check failed; open recovery options"]'
              ),
            ]
            stalePresentationInsertions.push(...candidates)
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      try {
        view.rerender(preview(true))
        await waitFor(() => expect(resolutions).toBe(2))
        await waitFor(() => expect(client.getQueryState(resourceKey)?.status).toBe('error'))
        await act(async () => Promise.resolve())
        expect(stalePresentationInsertions).toEqual([])
        expect(
          screen.queryByRole('button', {
            name: 'Permission check failed; open recovery options',
          })
        ).toBeNull()
        expect(screen.queryByRole('alertdialog')).toBeNull()
      } finally {
        observer.disconnect()
      }
    } finally {
      view?.unmount()
      client.clear()
    }
  })
})
