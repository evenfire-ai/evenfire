// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import {
  accessibleResource,
  listAccessiblePage,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { FilePreviewPage } from '../FilePreviewPage'

const hookMock = vi.hoisted(() => ({ useGfsBrowserController: vi.fn() }))

vi.mock('@hooks/domain/useGfsBrowserController', () => hookMock)
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/evenfire-renderer-test', isPackaged: false, isReady: () => false },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const uri = 'gfs://main/0123456789abcdef0123456789abcdef'
const resourceId = '0123456789abcdef0123456789abcdef'
const parentId = 'source-parent'
const fullAccess = delegationAffordances(
  new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
  false
)
const readOnly = delegationAffordances(new Set(['read']), false)

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function installGfs(options: {
  source?: () => Promise<ReturnType<typeof delegationAffordances>>
  resourceAffordances?: () => Promise<ReturnType<typeof delegationAffordances>>
  destination?: () => Promise<ReturnType<typeof delegationAffordances>>
  move?: (...args: unknown[]) => Promise<void>
  rename?: (...args: unknown[]) => Promise<void>
  listAccessible?: () => Promise<unknown>
}) {
  const resource = resolveResource({
    resourceId,
    rid: resourceId,
    gfsUri: uri,
    drive: 'main',
    parentResourceId: parentId,
    name: 'diagram.png',
    kind: 'file',
    version: 7,
    bytes: 1,
  })
  const resolve = vi.fn(async () => resource)
  const affordances = vi.fn(async (affordanceResourceId: string) => {
    if (affordanceResourceId === parentId) return (options.source ?? (async () => fullAccess))()
    if (affordanceResourceId === resourceId && options.resourceAffordances) {
      return options.resourceAffordances()
    }
    if (affordanceResourceId === 'destination-1') {
      return (options.destination ?? (async () => fullAccess))()
    }
    return fullAccess
  })
  const moveResource = vi.fn(options.move ?? (async () => undefined))
  const renameResource = vi.fn(options.rename ?? (async () => undefined))
  const deleteResource = vi.fn(async () => undefined)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      gfs: {
        resolve,
        affordances,
        listChildren: vi.fn(async () => ({ items: [], nextCursor: null })),
        downloadPreview: vi.fn(async () => ({ bytes: new Uint8Array([1]).buffer })),
        moveResource,
        renameResource,
        deleteResource,
        listAccessible: options.listAccessible ?? (async () => ({ items: [], nextCursor: null })),
      },
    },
  })
  return { affordances, moveResource, renameResource, deleteResource, resolve }
}

function renderPreview(pushToast?: (message: string, tone: Tone) => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <FilePreviewPage
        gfsUri={uri}
        fileName="diagram.png"
        fileKind="image"
        mimeType="image/png"
        byteLength={1}
        pushToast={pushToast}
      />
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

function installController() {
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope: 'preview-test-user:main',
    authorityPending: false,
    handleAuthorityFailure: vi.fn(() => false),
  })
}

async function openPreviewActions() {
  const heading = await screen.findByRole('heading', { name: 'diagram.png', level: 2 })
  const titleRow = heading.closest('.da-gfs-preview-title-row')
  if (!titleRow) throw new Error('Preview title actions are unavailable')
  fireEvent.click(
    within(titleRow as HTMLElement).getByRole('button', { name: 'Options for diagram.png' })
  )
  return screen.getByRole('menu', { name: 'Actions for diagram.png' })
}

describe('FilePreviewPage move permission contract', () => {
  it('keeps cached Preview actions visible during a background permission refetch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let resourceReads = 0
    let sourceReads = 0
    const permissionResponse = heldPermissionResponse([
      'read',
      'write',
      'delete',
      'manage_acl',
      'share',
    ])
    let releaseResourceRefresh!: (value: typeof permissionResponse) => void
    let releaseSourceRefresh!: (value: typeof permissionResponse) => void
    const resourceRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseResourceRefresh = resolve
    })
    const sourceRefresh = new Promise<typeof permissionResponse>(resolve => {
      releaseSourceRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(targetResourceId => {
      if (targetResourceId === resourceId) {
        resourceReads += 1
        return resourceReads === 1 ? Promise.resolve(permissionResponse) : resourceRefresh
      }
      if (targetResourceId === parentId) {
        sourceReads += 1
        return sourceReads === 1 ? Promise.resolve(permissionResponse) : sourceRefresh
      }
      return Promise.resolve(permissionResponse)
    })
    const { affordances } = installGfs({
      resourceAffordances: () => produceAffordances(resourceId),
      source: () => produceAffordances(parentId),
    })
    installController()
    const { queryClient } = renderPreview()
    try {
      await screen.findByAltText('Preview of diagram.png')
      await waitFor(() => {
        expect(resourceReads).toBe(1)
        expect(sourceReads).toBe(1)
      })
      await openPreviewActions()

      const mountedAt = Date.now()
      vi.setSystemTime(mountedAt + 16_000)
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => {
        expect(resourceReads).toBe(2)
        expect(sourceReads).toBe(2)
      })

      const menu = screen.getByRole('menu', { name: 'Actions for diagram.png' })
      expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
      expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
      expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()

      // Cached presentation is not permission to open the Move dialog. It joins
      // the background source check and opens only after that exact query resolves.
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
      expect(affordances).toHaveBeenCalledWith(resourceId, 'main')
      expect(affordances).toHaveBeenCalledWith(parentId, 'main')
      expect(affordances).toHaveBeenCalledTimes(4)

      await act(async () => {
        releaseSourceRefresh(permissionResponse)
        await Promise.resolve()
      })
      await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      expect(affordances).toHaveBeenCalledTimes(4)
      expect(window.clerum.gfs.moveResource).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Close move dialog' }))
      const reopenedMenu = await openPreviewActions()

      // Rename also waits for the pending exact resource query before opening.
      fireEvent.click(within(reopenedMenu).getByRole('menuitem', { name: 'Rename' }))
      expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull()
      expect(affordances).toHaveBeenCalledTimes(4)
      await act(async () => {
        releaseResourceRefresh(permissionResponse)
        await Promise.resolve()
      })
      await screen.findByRole('dialog', { name: 'Rename file' })
      expect(affordances).toHaveBeenCalledTimes(4)
    } finally {
      await act(async () => {
        releaseResourceRefresh(permissionResponse)
        releaseSourceRefresh(permissionResponse)
        await Promise.resolve()
      })
      focusManager.setFocused(undefined)
      queryClient.clear()
    }
  })

  it('keeps rename from mutating when its fresh permission check is denied', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let resourceReads = 0
    let releaseRefresh!: (value: ReturnType<typeof heldPermissionResponse>) => void
    const refresh = new Promise<ReturnType<typeof heldPermissionResponse>>(resolve => {
      releaseRefresh = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(() => {
      resourceReads += 1
      return resourceReads === 1
        ? Promise.resolve(
            heldPermissionResponse(['read', 'write', 'delete', 'manage_acl', 'share'])
          )
        : refresh
    })
    const { affordances, renameResource } = installGfs({
      resourceAffordances: () => produceAffordances(resourceId),
    })
    installController()
    const pushToast = vi.fn()
    const { queryClient } = renderPreview(pushToast)
    try {
      await screen.findByAltText('Preview of diagram.png')
      await waitFor(() => expect(resourceReads).toBe(1))
      const menu = await openPreviewActions()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
      const dialog = await screen.findByRole('dialog', { name: 'Rename file' })
      fireEvent.change(within(dialog).getByRole('textbox', { name: 'New name' }), {
        target: { value: 'renamed.png' },
      })

      vi.setSystemTime(Date.now() + 16_000)
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => expect(resourceReads).toBe(2))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
      expect(renameResource).not.toHaveBeenCalled()

      await act(async () => {
        releaseRefresh(heldPermissionResponse(['read', 'delete']))
        await Promise.resolve()
      })
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          'You do not have write access to diagram.png.',
          'error'
        )
      )
      expect(renameResource).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog', { name: 'Rename file' })).toBeTruthy()
      expect(resourceReads).toBe(2)
    } finally {
      await act(async () => {
        releaseRefresh(heldPermissionResponse(['read', 'delete']))
        await Promise.resolve()
      })
      focusManager.setFocused(undefined)
      queryClient.clear()
    }
  })

  it('retains cached Preview actions after a transient refresh error without using them as authority', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    let resourceReads = 0
    const produceAffordances = async () => {
      resourceReads += 1
      if (resourceReads === 1) {
        return delegationAffordances(
          new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
          false
        )
      }
      throw new TypeError('fetch failed')
    }
    const { renameResource } = installGfs({
      resourceAffordances: produceAffordances,
      source: async () => fullAccess,
    })
    installController()
    const pushToast = vi.fn()
    const { queryClient } = renderPreview(pushToast)
    try {
      await screen.findByAltText('Preview of diagram.png')
      await waitFor(() => expect(resourceReads).toBe(1))
      await openPreviewActions()

      vi.setSystemTime(Date.now() + 16_000)
      await act(async () => {
        focusManager.setFocused(false)
        focusManager.setFocused(true)
      })
      await waitFor(() => expect(resourceReads).toBe(2))

      const menu = screen.getByRole('menu', { name: 'Actions for diagram.png' })
      expect(within(menu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }))
      await waitFor(() => expect(resourceReads).toBe(3))
      expect(screen.queryByRole('dialog', { name: 'Rename file' })).toBeNull()
      expect(renameResource).not.toHaveBeenCalled()
      await waitFor(() =>
        expect(pushToast).toHaveBeenCalledWith(
          expect.stringContaining('Could not verify permissions'),
          'error'
        )
      )
    } finally {
      focusManager.setFocused(undefined)
      queryClient.clear()
    }
  })

  it.each([
    { target: 'resource', status: 403, hidden: ['Rename', 'Delete'] },
    { target: 'resource', status: 404, hidden: ['Rename', 'Delete'] },
    { target: 'source parent', status: 403, hidden: ['Move to'] },
    { target: 'source parent', status: 404, hidden: ['Move to'] },
  ])(
    'withholds cached $target actions after an explicit HTTP $status denial',
    async ({ target, status, hidden }) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      let resourceReads = 0
      let sourceReads = 0
      const denied = () =>
        Promise.reject(
          new Error(
            `Error invoking remote method 'gfs:affordances': Error: ${status} Forbidden httpStatus=${status}`
          )
        )
      installGfs({
        resourceAffordances: async () => {
          resourceReads += 1
          return target === 'resource' && resourceReads > 1 ? denied() : fullAccess
        },
        source: async () => {
          sourceReads += 1
          return target === 'source parent' && sourceReads > 1 ? denied() : fullAccess
        },
      })
      installController()
      const { queryClient } = renderPreview()
      try {
        await screen.findByAltText('Preview of diagram.png')
        await waitFor(() => {
          expect(resourceReads).toBe(1)
          expect(sourceReads).toBe(1)
        })
        await openPreviewActions()

        vi.setSystemTime(Date.now() + 16_000)
        await act(async () => {
          focusManager.setFocused(false)
          focusManager.setFocused(true)
        })
        await waitFor(() => {
          expect(resourceReads).toBe(2)
          expect(sourceReads).toBe(2)
        })

        await waitFor(() => {
          const refreshedMenu = screen.getByRole('menu', { name: 'Actions for diagram.png' })
          for (const action of hidden) {
            expect(within(refreshedMenu).queryByRole('menuitem', { name: action })).toBeNull()
          }
          if (target === 'resource') {
            expect(within(refreshedMenu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
          } else {
            expect(within(refreshedMenu).getByRole('menuitem', { name: 'Rename' })).toBeTruthy()
            expect(within(refreshedMenu).getByRole('menuitem', { name: 'Delete' })).toBeTruthy()
          }
        })
      } finally {
        focusManager.setFocused(undefined)
        queryClient.clear()
      }
    }
  )

  it('hides Move when the source parent has read and write but lacks delete', async () => {
    const sourceReadWrite = delegationAffordances(new Set(['read', 'write']), false)
    installGfs({ source: async () => sourceReadWrite })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
  })

  it('hides Move when the source parent has read and delete but lacks write', async () => {
    const sourceReadDelete = delegationAffordances(new Set(['read', 'delete']), false)
    installGfs({ source: async () => sourceReadDelete })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
  })

  it('allows Move from a write/delete parent even when the file itself is read-only', async () => {
    const sourceWriteDelete = delegationAffordances(new Set(['write', 'delete']), false)
    installGfs({ source: async () => sourceWriteDelete, destination: async () => readOnly })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()

    expect(within(menu).getByRole('menuitem', { name: 'Move to' })).toBeTruthy()
  })

  it('does not leave a denied Move notice on an idle read-only Preview', async () => {
    installGfs({ source: async () => readOnly })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    expect(
      screen.queryByText('You need write and delete access to the source folder to move this file.')
    ).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry permission check' })).toBeNull()
  })

  it('reports a Retry-After pause when Preview permission retry is not yet allowed', async () => {
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    const source = vi.fn(async () => {
      throw limited
    })
    const { affordances } = installGfs({ source })
    installController()
    const pushToast = vi.fn()
    renderPreview(pushToast)

    await screen.findByAltText('Preview of diagram.png')
    const notice = await screen.findByText(/Could not verify move permissions/)
    expect(notice).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith(parentId, 'main')
    fireEvent.click(screen.getByRole('button', { name: 'Retry permission check' }))

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith('Too many file requests — try again in 7s.', 'error')
    )
    expect(affordances).toHaveBeenCalledTimes(2)
  })

  it('hides Move until the source parent has server-derived write and delete bits', async () => {
    const { affordances } = installGfs({ source: async () => readOnly })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(affordances).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef', 'main')
    )
    const menu = await openPreviewActions()

    await waitFor(() =>
      expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()
    )
  })

  it('keeps Move hidden while the parent permission check is pending or unavailable', async () => {
    let finishSourceCheck!: (value: ReturnType<typeof delegationAffordances>) => void
    const sourceCheck = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      finishSourceCheck = resolve
    })
    const { affordances } = installGfs({ source: () => sourceCheck })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    expect(within(menu).queryByRole('menuitem', { name: 'Move to' })).toBeNull()

    await act(async () => finishSourceCheck(fullAccess))
    await waitFor(() =>
      expect(
        within(screen.getByRole('menu', { name: 'Actions for diagram.png' })).getByRole(
          'menuitem',
          { name: 'Move to' }
        )
      ).toBeTruthy()
    )
  })

  it('keeps server destination authorization authoritative and reports a denied destination', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    installGfs({
      destination: async () => readOnly,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('rejects a cached destination grant when fresh confirmation sees write revoked', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      destination: async () => readOnly,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()
    queryClient.setQueryData(
      desktopQueryKeys.gfsAffordances('preview-test-user:main', 'destination-1', 'main'),
      fullAccess
    )

    await screen.findByAltText('Preview of diagram.png')
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('You do not have write access to the destination folder.')
    ).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith(parentId, 'main')
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()
  })

  it('keeps a confirmed move visible while fresh source-parent permissions are pending', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let sourceCalls = 0
    let finishSourceRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      source: () => {
        sourceCalls += 1
        if (sourceCalls !== 2) return Promise.resolve(fullAccess)
        return new Promise(resolve => {
          finishSourceRefresh = resolve
        })
      },
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move here (Archive)' })).toBeTruthy()
    )

    void queryClient.invalidateQueries({
      predicate: query => query.queryKey.includes(parentId),
    })
    await waitFor(() => expect(sourceCalls).toBe(2))
    fireEvent.click(screen.getByRole('button', { name: 'Move here (Archive)' }))
    const checkingVisible = Boolean(screen.queryByText('Checking permissions…'))

    await act(async () => finishSourceRefresh(fullAccess))
    expect(checkingVisible).toBe(true)
    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith(
        '0123456789abcdef0123456789abcdef',
        'destination-1',
        'main',
        7
      )
    )
    expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
  })

  it('holds a source 429 retry until its Retry-After window expires', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let sourceCalls = 0
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    const source = vi.fn(async () => {
      sourceCalls += 1
      if (sourceCalls === 2) throw limited
      return fullAccess
    })
    const moveResource = vi.fn(async () => undefined)
    installGfs({ source, listAccessible: async () => destinationPage, move: moveResource })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(sourceCalls).toBe(1))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('Too many file requests — try again in 7s.')
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(moveResource).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(sourceCalls).toBe(2)
    expect(moveResource).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001)
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
    expect(within(dialog).getByRole('status').textContent).toContain(
      'Permissions verified. Select Move to confirm.'
    )
    expect(moveResource).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
    expect(moveResource).toHaveBeenCalledTimes(1)
    queryClient.clear()
  })

  it('does not let a successful permission retry commit Move without a second confirmation', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const limited = new Error(
      "Error invoking remote method 'gfs:affordances': 429 Too Many Requests " +
        'httpStatus=429 retryAfterSeconds=7'
    )
    let destinationCalls = 0
    const destination = vi.fn(async () => {
      destinationCalls += 1
      if (destinationCalls === 1) throw limited
      return fullAccess
    })
    const moveResource = vi.fn(async () => undefined)
    const { affordances } = installGfs({
      destination,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const { queryClient } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(affordances).toHaveBeenCalledWith(parentId, 'main'))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    expect(
      await within(dialog).findByText('Too many file requests — try again in 7s.')
    ).toBeTruthy()
    expect(within(dialog).getByRole('button', { name: 'Retry permission check' })).toBeTruthy()
    expect(affordances).toHaveBeenCalledWith(parentId, 'main')
    expect(affordances).toHaveBeenCalledWith('destination-1', 'main')
    expect(moveResource).not.toHaveBeenCalled()

    vi.useFakeTimers()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_001)
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
      for (let index = 0; index < 10; index += 1) await Promise.resolve()
    })
    expect(destination).toHaveBeenCalledTimes(2)
    expect.soft(moveResource).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('rejects a permission response after the preview resource changes', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let finishDestinationCheck!: (value: ReturnType<typeof delegationAffordances>) => void
    const destination = vi.fn(
      () =>
        new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
          finishDestinationCheck = resolve
        })
    )
    const moveResource = vi.fn(async () => undefined)
    const { resolve } = installGfs({
      destination,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    })
    const renderPage = (activeUri = uri, activeFileName = 'diagram.png') => (
      <QueryClientProvider client={queryClient}>
        <FilePreviewPage
          gfsUri={activeUri}
          fileName={activeFileName}
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
          pushToast={vi.fn()}
        />
      </QueryClientProvider>
    )
    const view = render(renderPage())

    await screen.findByAltText('Preview of diagram.png')
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move here (Archive)' })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(destination).toHaveBeenCalledOnce())
    expect(within(dialog).getByText('Checking permissions…')).toBeTruthy()

    const nextUri = 'gfs://main/abcdefabcdefabcdefabcdefabcdefab'
    const nextResource = await resolveResource({
      resourceId: 'abcdefabcdefabcdefabcdefabcdefab',
      rid: 'abcdefabcdefabcdefabcdefabcdefab',
      gfsUri: nextUri,
      drive: 'main',
      parentResourceId: 'source-parent-2',
      name: 'replacement.png',
      kind: 'file',
      version: 8,
      bytes: 1,
    })
    resolve.mockResolvedValue(nextResource)
    view.rerender(renderPage(nextUri, 'replacement.png'))
    await screen.findByRole('heading', { name: 'replacement.png', level: 2 })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
    )
    await act(async () => finishDestinationCheck(fullAccess))

    expect(resolve).toHaveBeenLastCalledWith(nextUri)
    expect(moveResource).not.toHaveBeenCalled()
    queryClient.clear()
  })

  it('moves with exact resource version after both parent and destination checks pass', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const moveResource = vi.fn(async () => undefined)
    const pushToast = vi.fn()
    installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: moveResource,
    })
    installController()
    renderPreview(pushToast)

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() =>
      expect(window.clerum.gfs.affordances).toHaveBeenCalledWith(parentId, 'main')
    )
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(moveResource).toHaveBeenCalledWith(
        '0123456789abcdef0123456789abcdef',
        'destination-1',
        'main',
        7
      )
    )
    expect(pushToast).toHaveBeenCalledWith('Moved diagram.png to Archive', 'success')
    expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
  })

  it('closes a Preview Retry owned by a previous session scope', async () => {
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    let sourceReads = 0
    let finishRetry!: () => void
    const retry = new Promise<void>(resolve => {
      finishRetry = resolve
    })
    const produceAffordances = appServiceAffordanceProducer(async resourceId => {
      if (resourceId === parentId) {
        sourceReads += 1
        if (sourceReads === 2) return heldPermissionResponse(['read'])
        if (sourceReads === 3) await retry
      }
      return heldPermissionResponse(['read', 'write', 'delete'])
    })
    const source = vi.fn(async () => produceAffordances(parentId))
    const destination = async () => produceAffordances('destination-1')
    installGfs({ source, destination, listAccessible: async () => destinationPage })
    installController()
    const { queryClient, rerender } = renderPreview()

    await screen.findByAltText('Preview of diagram.png')
    await waitFor(() => expect(sourceReads).toBe(1))
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    expect(
      await within(dialog).findByText(
        'You do not have write and delete access to the source folder.'
      )
    ).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Retry permission check' }))
    await waitFor(() => expect(sourceReads).toBe(3))
    hookMock.useGfsBrowserController.mockReturnValue({
      accessState: 'active',
      sessionScope: 'preview-test-user-b:main',
      authorityPending: false,
      handleAuthorityFailure: vi.fn(() => false),
    })
    rerender(
      <QueryClientProvider client={queryClient}>
        <FilePreviewPage
          gfsUri={uri}
          fileName="diagram.png"
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
        />
      </QueryClientProvider>
    )
    await act(async () => {
      finishRetry()
    })

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(window.clerum.gfs.moveResource).not.toHaveBeenCalled()
  })
})
