// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { FilesPage } from '@/pages/FilesPage'
import {
  accessibleResource,
  affordancesResult,
  childView,
  heldAffordances,
  listAccessiblePage,
  listChildrenPage,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '../__fixtures__/gfsProducerFixtures'
import { GfsDragSessionProvider, useGfsDragSession } from '../dragSession'
import type { GfsDragSessionApi } from '../dragSession.types'

const mocks = vi.hoisted(() => ({
  controller: vi.fn(),
  auth: {
    isAuthenticated: true,
    me: { id: 'user-1', teamId: 'team-1' },
    runtimeConfigState: { envKey: 'env-1' },
    sessionGeneration: 0,
  },
}))
vi.mock('@hooks/domain/useGfsBrowserController', () => ({
  useGfsBrowserController: mocks.controller,
  GFS_UNAVAILABLE_LOCATION_MESSAGE: 'This folder or file is no longer available.',
}))
vi.mock('@contexts/AuthContext', () => ({ useAuthContext: () => mocks.auth }))

function baseController() {
  return {
    current: null,
    crumbs: [],
    sessionScope: 'env-1:user-1:team-1',
    sessionGeneration: 0,
    accessibleResources: [],
    items: [],
    affordances: null,
    affordancesError: null,
    loadingAffordances: false,
    rowAffordancesResourceId: null,
    setRowAffordancesResourceId: vi.fn(),
    rowAffordancesByResourceId: {},
    rowAffordances: null,
    rowAffordancesError: null,
    loadingAccessible: false,
    loading: false,
    accessibleError: null,
    accessibleNotice: null,
    error: null,
    openError: null,
    resolving: false,
    hasMoreAccessible: false,
    isFetchingMoreAccessible: false,
    hasMore: false,
    isFetchingMore: false,
    loadMoreAccessible: vi.fn(),
    loadMore: vi.fn(),
    openUri: vi.fn(),
    openResource: vi.fn(),
    openChild: vi.fn(),
    goToCrumb: vi.fn(),
    restoreCrumbs: vi.fn(),
    grant: vi.fn(),
    grants: [],
    grantsError: null,
    loadingGrants: false,
    refreshGrants: vi.fn(),
    inheritedAccess: [],
    loadingInheritedAccess: false,
    refreshInheritedAccess: vi.fn(),
    revokeGrant: vi.fn(),
    revoking: false,
    shares: [],
    sharesError: null,
    loadingShares: false,
    refreshShares: vi.fn(),
    revokeShare: vi.fn(),
    revokingShare: false,
    accessState: 'active',
    retryAccess: vi.fn(),
    handleAuthorityFailure: vi.fn(() => false),
    createShare: vi.fn(),
    createFolder: vi.fn(),
    createFile: vi.fn(),
    createFileFromPath: vi.fn(),
    replaceFile: vi.fn(),
    replaceFileFromPath: vi.fn(),
    renameResource: vi.fn(),
    moveResource: vi.fn(),
    convergeCommittedMove: vi.fn(),
    deleteResource: vi.fn(),
    mutating: false,
    reset: vi.fn(),
    refreshAffordances: vi.fn(),
    discoveryFailure: null,
    retryDiscovery: vi.fn(),
    authorityPending: false,
    errorUpdatedAt: 0,
    retryChildren: vi.fn(),
  }
}

// Controller values model local UI state; wire values pass through the real
// GfsClient and structured-clone fixture producers.
function SessionProbe({ onApi }: { onApi: (api: GfsDragSessionApi) => void }) {
  const api = useGfsDragSession()
  if (api) onApi(api)
  return null
}
function transfer() {
  return {
    types: ['application/x-evenfire-gfs-resource'],
    files: [],
    effectAllowed: 'move',
    dropEffect: 'none',
    setData: vi.fn(),
  }
}
function externalSource() {
  return {
    resourceId: 'external',
    gfsUri: 'gfs://main/external',
    drive: 'main',
    kind: 'file' as const,
    name: 'external.txt',
    parentKnown: true,
    parentResourceId: 'grand',
    knownAncestorIds: ['grand'],
    origin: 'files' as const,
    scope: 'env-1:user-1:team-1',
  }
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  mocks.auth.me = { id: 'user-1', teamId: 'team-1' }
})

for (const surface of ['sidebar', 'files'] as const) {
  describe(`${surface} drop ownership (R1-M4)`, () => {
    async function setup(
      sourceKind: 'file' | 'directory' = 'directory',
      delayed = false,
      denyTarget = false,
      parkResolve = false
    ) {
      const bits = await affordancesResult(heldAffordances(['read', 'write', 'delete']))
      let release!: () => void
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      let parked = delayed
      const affordances = vi.fn(async (id: string, _drive: string) => {
        if (parked && id === 'target') {
          parked = false
          await gate
        }
        return denyTarget && id === 'target' ? affordancesResult(heldAffordances(['read'])) : bits
      })
      // The COMMIT-TIME resolve is the last read before the PATCH. Parking it
      // reproduces the window the ownership re-check exists for: the gesture
      // can be superseded while the source is being re-resolved.
      let resolveGate: Promise<void> | null = null
      let releaseResolve!: () => void
      if (parkResolve) {
        resolveGate = new Promise<void>(resolve => {
          releaseResolve = resolve
        })
      }
      const resolve = vi.fn(async (uri: string) => {
        if (resolveGate) await resolveGate
        const id = uri.split('/').pop()!
        return resolveResource(
          id === 'external' || (id === 'source' && sourceKind === 'file')
            ? resolvedFile(id, id === 'external' ? 'external.txt' : 'Source', {
                parentResourceId: 'grand',
              })
            : resolvedDirectory(id, id === 'source' ? 'Source' : id, {
                parentResourceId: id === 'grand' ? null : 'grand',
              })
        )
      })
      const moveResource = vi.fn(async (_id: string, _destination: string) => ({}))
      Object.defineProperty(window, 'clerum', {
        configurable: true,
        value: {
          auth: { getSessionGeneration: vi.fn(async () => 0) },
          gfs: {
            listChildren: vi.fn(async () =>
              listChildrenPage([
                childView('source', 'Source', sourceKind, { parentResourceId: 'grand' }),
                childView('target', 'Target', 'directory', { parentResourceId: 'grand' }),
                childView('hover', 'Hover', 'directory', { parentResourceId: 'grand' }),
              ])
            ),
            affordances,
            resolve,
          },
        },
      })
      const { items } = await listAccessiblePage([
        accessibleResource('source', 'Source', sourceKind, { parentResourceId: 'grand' }),
        accessibleResource('target', 'Target', 'directory', { parentResourceId: 'grand' }),
        accessibleResource('hover', 'Hover', 'directory', { parentResourceId: 'grand' }),
      ])
      const ctrl = {
        ...baseController(),
        accessibleResources:
          surface === 'sidebar'
            ? (await listAccessiblePage([accessibleResource('grand', 'Grand', 'directory')])).items
            : items,
        items,
        moveResource,
      }
      mocks.controller.mockReturnValue(ctrl)
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      let api!: GfsDragSessionApi
      const toast = vi.fn()
      let mounted = true
      const view = () => (
        <QueryClientProvider client={queryClient}>
          <GfsDragSessionProvider>
            {!mounted ? null : surface === 'sidebar' ? (
              <FileExplorerTree
                onOpenFolder={vi.fn()}
                onOpenPreview={vi.fn()}
                onResourceAction={vi.fn()}
                pushToast={toast}
              />
            ) : (
              <FilesPage pushToast={toast} />
            )}
            <SessionProbe
              onApi={value => {
                api = value
              }}
            />
          </GfsDragSessionProvider>
        </QueryClientProvider>
      )
      const rendered = render(view())
      if (surface === 'sidebar') {
        fireEvent.click(screen.getByRole('button', { name: 'Expand Grand' }))
        await screen.findByRole('button', { name: 'Source' })
      }
      const row = (name: string) => {
        const button = screen.getByRole('button', {
          name: surface === 'sidebar' ? name : `Open ${name}`,
        })
        return surface === 'sidebar'
          ? button.closest('[role="treeitem"]')!.querySelector('.da-file-explorer__row')!
          : button
      }
      const dataTransfer = transfer()
      const sourceElement = () =>
        screen.getByRole('button', { name: surface === 'sidebar' ? 'Source' : 'Open Source' })
      const start = () => fireEvent.dragStart(sourceElement(), { dataTransfer })
      const drop = () => fireEvent.drop(row('Target'), { dataTransfer })
      const dropState = (name: string) => row(name).getAttribute('data-drop-state')
      return {
        dropState,
        sourceElement,
        ctrl,
        api: () => api,
        row,
        start,
        drop,
        dataTransfer,
        release,
        releaseResolve,
        resolve,
        moveResource,
        affordances,
        toast,
        rerender: () => rendered.rerender(view()),
        unmountSurface: () => {
          mounted = false
          rendered.rerender(view())
        },
      }
    }

    it.each(['file', 'directory'] as const)(
      'rejects late %s admission and preserves the newer cross-surface hover check',
      async kind => {
        const h = await setup(kind, true)
        h.start()
        h.drop()
        await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('target', 'main'))
        expect(h.api().beginDrag(externalSource())).toBe(true)
        fireEvent.dragOver(h.row('Hover'), { dataTransfer: h.dataTransfer })
        expect(h.dropState('Hover')).toBe('checking')
        await act(async () => {
          h.release()
        })
        expect(screen.queryByRole('dialog', { name: 'Move folder Source to Target' })).toBeNull()
        expect(h.moveResource).not.toHaveBeenCalled()
        expect(h.toast).not.toHaveBeenCalled()
        expect(h.dropState('Hover')).toBe('checking')
        expect(h.api().activeSource()?.resourceId).toBe('external')
        await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('hover', 'main'))
        fireEvent.drop(h.row('Hover'), { dataTransfer: h.dataTransfer })
        await waitFor(() => expect(h.moveResource).toHaveBeenCalled())
        expect(h.moveResource.mock.calls[0]![0]).toBe('external')
        expect(h.moveResource.mock.calls[0]![1]).toBe('hover')
      }
    )

    it('does not dispatch a pending admission after its destination surface unmounts', async () => {
      const h = await setup('file', true)
      h.start()
      h.drop()
      await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('target', 'main'))
      h.unmountSurface()
      await act(async () => {
        h.release()
      })
      expect(h.moveResource).not.toHaveBeenCalled()
      expect(h.toast).not.toHaveBeenCalled()
    })

    it('suppresses a stale denial without clearing the newer source', async () => {
      const h = await setup('file', true, true)
      h.start()
      h.drop()
      await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('target', 'main'))
      h.api().beginDrag(externalSource())
      await act(async () => {
        h.release()
      })
      expect(h.toast).not.toHaveBeenCalled()
      expect(h.moveResource).not.toHaveBeenCalled()
      expect(h.api().activeSource()?.resourceId).toBe('external')
    })

    it('names the cross-surface source in the denied hover tooltip (UX matrix §5.1)', async () => {
      // The gesture begins on the OTHER surface through the shared session —
      // no local dragstart ever fires here, so the tooltip's source name must
      // come from the hover-resolved shared source, not a local dragstart.
      // Runs for both surfaces: files→sidebar and sidebar→files.
      const h = await setup('file')
      expect(
        h.api().beginDrag({
          resourceId: 'external',
          gfsUri: 'gfs://main/external',
          drive: 'main',
          kind: 'file',
          name: 'external.txt',
          parentKnown: true,
          // The external source already lives in Hover: structure denies
          // same-parent immediately, no probe needed.
          parentResourceId: 'hover',
          knownAncestorIds: ['hover'],
          origin: 'files',
          scope: 'env-1:user-1:team-1',
        })
      ).toBe(true)
      fireEvent.dragOver(h.row('Hover'), { dataTransfer: h.dataTransfer })
      expect(h.dropState('Hover')).toBe('denied')
      expect(h.row('Hover').getAttribute('data-drop-reason')).toBe('same-parent')
      // Not "This item is already in Hover." — the resolved source's own name.
      expect(h.row('Hover').getAttribute('title')).toBe('external.txt is already in Hover.')
      expect(screen.getByText('external.txt is already in Hover.')).toBeTruthy()
    })

    it('reports an already dispatched move without clearing newer hover work', async () => {
      const h = await setup('file')
      let finish!: () => void
      const mutation = new Promise<void>(resolve => {
        finish = resolve
      })
      h.moveResource.mockImplementationOnce(async () => {
        await mutation
        return {}
      })
      h.start()
      h.drop()
      await waitFor(() => expect(h.moveResource).toHaveBeenCalled())
      h.api().beginDrag(externalSource())
      fireEvent.dragOver(h.row('Hover'), { dataTransfer: h.dataTransfer })
      await act(async () => {
        finish()
      })
      expect(h.toast).toHaveBeenCalledWith('Moved Source to Target', 'success')
      expect(h.api().activeSource()?.resourceId).toBe('external')
      expect(h.dropState('Hover')).toBe('checking')
      await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('hover', 'main'))
    })

    it.each(['scope', 'revoked'] as const)(
      'rejects pending adjudication after native end and %s change',
      async change => {
        const h = await setup('directory', true)
        h.start()
        h.drop()
        await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('target', 'main'))
        fireEvent.dragEnd(h.sourceElement(), { dataTransfer: h.dataTransfer })
        if (change === 'scope') {
          mocks.auth.me = { id: 'user-1', teamId: 'team-2' }
          h.ctrl.sessionScope = 'env-1:user-1:team-2'
        } else h.ctrl.accessState = 'revoked'
        h.rerender()
        await act(async () => {
          h.release()
        })
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(h.moveResource).not.toHaveBeenCalled()
        expect(h.toast).not.toHaveBeenCalled()
      }
    )

    it.each(['end', 'invalidate'] as const)(
      'never resurrects the local descriptor after shared %s',
      async action => {
        const h = await setup()
        h.start()
        if (action === 'end') h.api().endDrag()
        else h.api().invalidate('authority')
        fireEvent.dragOver(h.row('Target'), { dataTransfer: h.dataTransfer })
        await act(async () => {
          h.drop()
        })
        expect(h.affordances).not.toHaveBeenCalled()
        expect(screen.queryByRole('dialog')).toBeNull()
        expect(h.moveResource).not.toHaveBeenCalled()
      }
    )

    it.each(['scope', 'revoked'] as const)(
      'dismisses a pending folder confirmation on %s change',
      async change => {
        const h = await setup()
        h.start()
        h.drop()
        await screen.findByRole('dialog', { name: 'Move folder Source to Target' })
        fireEvent.dragEnd(h.sourceElement(), { dataTransfer: h.dataTransfer })
        if (change === 'scope') {
          mocks.auth.me = { id: 'user-1', teamId: 'team-2' }
          h.ctrl.sessionScope = 'env-1:user-1:team-2'
        } else h.ctrl.accessState = 'revoked'
        h.rerender()
        expect(screen.queryByRole('dialog', { name: 'Move folder Source to Target' })).toBeNull()
        expect(h.moveResource).not.toHaveBeenCalled()
      }
    )

    it('refuses a confirmation superseded by another surface gesture', async () => {
      const h = await setup()
      h.start()
      h.drop()
      const dialog = await screen.findByRole('dialog', { name: 'Move folder Source to Target' })
      expect(h.api().beginDrag(externalSource())).toBe(true)
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
      })
      expect(h.moveResource).not.toHaveBeenCalled()
      expect(h.api().activeSource()?.resourceId).toBe('external')
    })

    it('preserves a valid admitted confirmation across ordinary native end', async () => {
      const h = await setup('directory', true)
      h.start()
      h.drop()
      await waitFor(() => expect(h.affordances).toHaveBeenCalledWith('target', 'main'))
      fireEvent.dragEnd(h.sourceElement(), { dataTransfer: h.dataTransfer })
      await act(async () => {
        h.release()
      })
      const dialog = await screen.findByRole('dialog', { name: 'Move folder Source to Target' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }))
      await waitFor(() => expect(h.moveResource).toHaveBeenCalled())
      expect(h.moveResource.mock.calls[0]![0]).toBe('source')
      expect(h.moveResource.mock.calls[0]![1]).toBe('target')
    })

    it('never dispatches when the gesture is superseded during the commit-time resolve', async () => {
      // The drop is admitted, then the shared session takes a NEW gesture
      // while the commit-time resolve of the source is still in flight. The
      // PATCH must not go out: the superseded session no longer owns it.
      const h = await setup('file', false, false, true)
      h.start()
      h.drop()
      await waitFor(() => expect(h.resolve).toHaveBeenCalled())
      expect(h.api().beginDrag(externalSource())).toBe(true)
      await act(async () => {
        h.releaseResolve()
      })
      expect(h.moveResource).not.toHaveBeenCalled()
      expect(h.toast).not.toHaveBeenCalled()
      expect(h.api().activeSource()?.resourceId).toBe('external')
    })

    it('dispatches the commit-time parent, not the drag-start parent', async () => {
      // The item was moved elsewhere since the gesture started: the
      // commit-time resolve sees a DIFFERENT parent than the drag did. The
      // convergence must drop the item from the folder it really left, so the
      // PATCH carries the resolved parent — the drag-start parent would
      // leave a ghost row in the real old folder.
      const h = await setup('file')
      h.resolve.mockImplementation(async (uri: string) => {
        const id = uri.split('/').pop()!
        return resolvedFile(id, 'Source', { parentResourceId: 'other-parent' })
      })
      h.start()
      h.drop()
      await waitFor(() => expect(h.moveResource).toHaveBeenCalled())
      expect(h.moveResource).toHaveBeenCalledWith(
        'source',
        'target',
        expect.any(Number),
        undefined,
        'other-parent',
        h.ctrl.sessionScope,
        true,
        0
      )
    })

    it('revokes the session when a drag probe answers 401', async () => {
      // A probe 401 is a session failure: the drop is refused AND the session
      // must be revoked, not left active over a dead session.
      const h = await setup('file')
      const message = 'Error invoking remote method: Error: 401 Unauthorized httpStatus=401'
      const error = new Error(message)
      h.affordances.mockImplementation(async () => {
        throw error
      })
      h.start()
      h.drop()
      await waitFor(() =>
        expect(h.ctrl.handleAuthorityFailure).toHaveBeenCalledWith(
          expect.objectContaining({ message }),
          'operation',
          h.ctrl.sessionScope,
          h.ctrl.sessionGeneration
        )
      )
      expect(h.moveResource).not.toHaveBeenCalled()
      expect(h.toast).not.toHaveBeenCalled()
    })

    it('converges the cache when the move landed but its response was lost', async () => {
      // The PATCH lands, the response never arrives: the mutation REJECTS, so
      // the mutation's own success path (and the convergence it owns) never
      // runs. The commit verifies the move by resolve, and the surface then
      // converges the cache itself — otherwise the item keeps rendering in
      // the old folder until the next navigation.
      const h = await setup('file')
      const original = h.resolve.getMockImplementation()!
      let resolveCalls = 0
      h.resolve.mockImplementation(async (uri: string) => {
        resolveCalls += 1
        const resolved = await original(uri)
        // The commit-time resolve still sees the OLD parent; the verification
        // resolve sees the item in the destination.
        return resolveCalls >= 2 ? { ...resolved, parentResourceId: 'target' } : resolved
      })
      h.moveResource.mockImplementationOnce(async () => {
        throw new Error('network error')
      })
      h.start()
      h.drop()
      await waitFor(() => expect(h.ctrl.convergeCommittedMove).toHaveBeenCalled())
      expect(h.ctrl.convergeCommittedMove).toHaveBeenCalledWith(
        {
          resourceId: 'source',
          destinationId: 'target',
          oldParentId: 'grand',
          expectedSessionGeneration: 0,
        },
        { version: expect.any(Number) },
        h.ctrl.sessionScope
      )
      expect(h.toast).toHaveBeenCalledWith('Moved Source to Target', 'success')
    })
  })
}

// RP-002: a session failure while resolving the drop target's ancestry ends
// the gesture. The Files page is the surface where that read happens: its
// rows carry no loaded ancestry (the current view is a root listing), so a
// folder drop must resolve the target's ancestors before it can admit the
// move — and a session that died during that read must never end in an
// ALLOWED verdict.
describe('files surface drop admission (RP-002)', () => {
  it('never dispatches the move when the ancestor resolve reports a session failure', async () => {
    const message = 'Error invoking remote method: Error: 401 Unauthorized httpStatus=401'
    const error = new Error(message)
    const bits = await affordancesResult(heldAffordances(['read', 'write', 'delete']))
    const affordances = vi.fn(async () => bits)
    const resolve = vi.fn(async () => {
      throw error
    })
    Object.defineProperty(window, 'clerum', {
      configurable: true,
      value: {
        auth: { getSessionGeneration: vi.fn(async () => 0) },
        gfs: {
          listChildren: vi.fn(async () => listChildrenPage([])),
          affordances,
          resolve,
        },
      },
    })
    const { items } = await listAccessiblePage([
      accessibleResource('source', 'Source', 'directory', { parentResourceId: 'grand' }),
      accessibleResource('target', 'Target', 'directory', { parentResourceId: 'grand' }),
    ])
    const moveResource = vi.fn(async () => ({}))
    const ctrl = { ...baseController(), accessibleResources: items, items, moveResource }
    mocks.controller.mockReturnValue(ctrl)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const toast = vi.fn()

    render(
      <QueryClientProvider client={queryClient}>
        <GfsDragSessionProvider>
          <FilesPage pushToast={toast} />
        </GfsDragSessionProvider>
      </QueryClientProvider>
    )

    const dataTransfer = transfer()
    fireEvent.dragStart(screen.getByRole('button', { name: 'Open Source' }), { dataTransfer })
    fireEvent.drop(screen.getByRole('button', { name: 'Open Target' }), { dataTransfer })

    // The session is revoked and the gesture ends: no confirmation, no
    // dispatch, nothing announced.
    await waitFor(() =>
      expect(ctrl.handleAuthorityFailure).toHaveBeenCalledWith(
        expect.objectContaining({ message }),
        'operation',
        ctrl.sessionScope,
        ctrl.sessionGeneration
      )
    )
    expect(screen.queryByRole('dialog', { name: 'Move folder Source to Target' })).toBeNull()
    expect(moveResource).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
    // The ancestry read is the last thing that ran: no affordance probe
    // followed it.
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(affordances).not.toHaveBeenCalled()
  })
})
