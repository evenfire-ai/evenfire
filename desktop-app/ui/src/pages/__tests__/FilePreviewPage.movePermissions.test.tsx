// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ToastStack } from '@components/Common/ToastStack'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useToastController } from '@hooks/domain/useToastController'
import {
  accessibleResource,
  gfsRouteFailureMessage,
  listAccessiblePage,
  resolveResource,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import type { Tone } from '@/uiTypes'
import { delegationAffordances } from '../../../../src/gfs/delegation.js'
import { GfsClient } from '../../../../src/gfs/uriHandler'
import { requestJson } from '../../../../src/httpClient'
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
type MoveReceipt = Awaited<ReturnType<typeof window.clerum.gfs.moveResource>>
const successfulMoveReceipt: MoveReceipt = { resourceId, version: 8 }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function installGfs(options: {
  source?: () => Promise<ReturnType<typeof delegationAffordances>>
  resourceAffordances?: () => Promise<ReturnType<typeof delegationAffordances>>
  destination?: () => Promise<ReturnType<typeof delegationAffordances>>
  move?: (...args: unknown[]) => Promise<MoveReceipt>
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
  const moveResource = vi.fn(options.move ?? (async () => ({ resourceId, version: 8 })))
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

function ToastingPreview({
  gfsUri = uri,
  fileName = 'diagram.png',
  showPreview = true,
}: { gfsUri?: string; fileName?: string; showPreview?: boolean } = {}) {
  const toast = useToastController()
  return (
    <>
      {showPreview ? (
        <FilePreviewPage
          gfsUri={gfsUri}
          fileName={fileName}
          fileKind="image"
          mimeType="image/png"
          byteLength={1}
          pushToast={toast.pushToast}
        />
      ) : null}
      <ToastStack items={toast.toasts} onDismiss={toast.dismissToast} />
    </>
  )
}

function renderPreviewWithToastStack(props: { gfsUri?: string; fileName?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastingPreview {...props} />
    </QueryClientProvider>
  )
  return { ...view, queryClient }
}

function installController(sessionScope = 'preview-test-user:main') {
  const handleAuthorityFailure = vi.fn(() => false)
  hookMock.useGfsBrowserController.mockReturnValue({
    accessState: 'active',
    sessionScope,
    authorityPending: false,
    handleAuthorityFailure,
  })
  return handleAuthorityFailure
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
    const { renameResource } = installGfs({
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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
    const moveResource = vi.fn(async () => ({ resourceId, version: 8 }))
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

describe('FilePreviewPage dispatched Move outcome ownership', () => {
  const moveMessage = 'Moved diagram.png to Archive'
  const sessionScope = 'preview-test-user:main'

  async function dispatchArchiveMove() {
    await screen.findByAltText('Preview of diagram.png')
    const menu = await openPreviewActions()
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
    const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
    await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(window.clerum.gfs.moveResource).toHaveBeenCalledTimes(1))
    return dialog
  }

  it('reports one confirmed success after close and invalidates only the captured session cache', async () => {
    let settleMove!: (receipt: MoveReceipt) => void
    const pendingMove = new Promise<MoveReceipt>(resolve => {
      settleMove = resolve
    })
    const movedResource = await resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'destination-1',
      name: 'diagram.png',
      kind: 'file',
      version: 8,
      bytes: 1,
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource, resolve } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    const capturedSessionCache = desktopQueryKeys.gfsChildren(sessionScope, parentId, 'main')
    const otherSessionCache = desktopQueryKeys.gfsChildren('other-user:main', parentId, 'main')
    queryClient.setQueryDefaults(capturedSessionCache, { gcTime: 60_000 })
    queryClient.setQueryDefaults(otherSessionCache, { gcTime: 60_000 })
    try {
      const dialog = await dispatchArchiveMove()
      queryClient.setQueryData(capturedSessionCache, { items: [], nextCursor: null })
      queryClient.setQueryData(otherSessionCache, { items: [], nextCursor: null })
      expect(queryClient.getQueryState(capturedSessionCache)?.isInvalidated).toBe(false)
      expect(queryClient.getQueryState(otherSessionCache)?.isInvalidated).toBe(false)
      expect(moveResource).toHaveBeenCalledTimes(1)
      expect(moveResource).toHaveBeenCalledWith(resourceId, 'destination-1', 'main', 7)
      expect(screen.queryByText(moveMessage)).toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
      expect(screen.queryByText(moveMessage)).toBeNull()
      expect(queryClient.getQueryState(capturedSessionCache)?.isInvalidated).toBe(false)

      resolve.mockResolvedValue(movedResource)
      await act(async () => settleMove(successfulMoveReceipt))

      expect(await screen.findByText(moveMessage)).toBeTruthy()
      expect(screen.getAllByText(moveMessage)).toHaveLength(1)
      expect(
        queryClient.getQueryData([
          ...desktopQueryKeys.gfsRoot,
          sessionScope,
          'preview-resource',
          uri,
        ])
      ).toEqual(movedResource)
      expect(queryClient.getQueryState(capturedSessionCache)?.isInvalidated).toBe(true)
      expect(queryClient.getQueryState(otherSessionCache)?.isInvalidated).toBe(false)
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => settleMove(successfulMoveReceipt))
      queryClient.clear()
    }
  })

  it('shows one safe failure after close without repeating the Move', async () => {
    let rejectMove!: (error: Error) => void
    const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectMove = reject
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    try {
      const dialog = await dispatchArchiveMove()
      expect(moveResource).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('alert')).toBeNull()

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
      expect(screen.queryByRole('alert')).toBeNull()
      await act(async () => rejectMove(new Error('Move rejected httpStatus=400')))

      const failure = await screen.findByRole('alert')
      expect(failure.textContent).toContain('diagram.png → Archive:')
      expect(failure.textContent).toContain(
        'The server rejected this destination. Refresh and choose a different folder.'
      )
      expect(failure.className).toBe('toast tone-error')
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => rejectMove(new Error('Move rejected httpStatus=400')))
      queryClient.clear()
    }
  })

  it.each([
    [
      412,
      'precondition_failed',
      'stale file version',
      'This item changed while you were moving it. Review its current location and try again.',
      'error',
    ],
    [
      403,
      'forbidden',
      'move permission denied',
      'EvenDrive could not confirm permission for this move. Refresh and try again.',
      'warn',
    ],
    [429, 'rate_limited', 'too many requests', 'Too many file requests — try again in 7s.', 'warn'],
    [
      409,
      'name_conflict',
      'a destination item already exists',
      'An item with this name already exists. Choose another folder, or use Move to change its name if you have rename access.',
      'error',
    ],
  ] as const)(
    'uses the shared safe Move verdict for a real GFS %i after close',
    async (status, code, serverMessage, expectedMessage, expectedTone) => {
      const failureMessage = await gfsRouteFailureMessage(
        client =>
          client.moveResource(
            { resourceId, destinationId: 'destination-1', ifMatch: 7 },
            'fixture-session-token'
          ),
        status,
        { code, message: serverMessage },
        status === 429 ? { 'retry-after': '7' } : {}
      )
      let rejectMove!: (error: Error) => void
      const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
        rejectMove = reject
      })
      const destinationPage = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', {
          permissions: ['read', 'write'],
        }),
      ])
      const { moveResource } = installGfs({
        destination: async () => fullAccess,
        listAccessible: async () => destinationPage,
        move: () => pendingMove,
      })
      installController(sessionScope)
      const { queryClient } = renderPreviewWithToastStack()
      try {
        const dialog = await dispatchArchiveMove()
        expect(moveResource).toHaveBeenCalledTimes(1)
        expect(moveResource).toHaveBeenCalledWith(resourceId, 'destination-1', 'main', 7)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))

        await act(async () => rejectMove(new Error(failureMessage)))

        expect(await screen.findByText(`diagram.png → Archive: ${expectedMessage}`)).toBeTruthy()
        expect(screen.getAllByRole(expectedTone === 'error' ? 'alert' : 'status')).toHaveLength(1)
        expect(
          screen
            .getByRole(expectedTone === 'error' ? 'alert' : 'status')
            .className.endsWith(`tone-${expectedTone}`)
        ).toBe(true)
        expect(screen.queryByText(failureMessage)).toBeNull()
        expect(moveResource).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => rejectMove(new Error(failureMessage)))
        queryClient.clear()
      }
    }
  )

  it('verifies a status-free Preview Move transport failure without repeating the PATCH', async () => {
    const { createServer } = await import('node:http')
    const server = createServer(request => request.socket.destroy())
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    let transportError: Error | undefined
    try {
      const address = server.address() as import('node:net').AddressInfo
      const client = new GfsClient({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requestJson,
        fetchBytes: async () => new ArrayBuffer(0),
      })
      try {
        await client.moveResource(
          { resourceId, destinationId: 'destination-1', ifMatch: 7 },
          'fixture-session-token'
        )
      } catch (error) {
        transportError = error instanceof Error ? error : new Error(String(error))
      }
      expect(transportError).toBeInstanceOf(Error)
      if (!transportError) throw new Error('Expected a status-free Move transport failure')
      const capturedTransportError = transportError

      const destinationPage = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', {
          permissions: ['read', 'write'],
        }),
      ])
      let rejectMove!: (error: Error) => void
      const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
        rejectMove = reject
      })
      const { moveResource, resolve } = installGfs({
        destination: async () => fullAccess,
        listAccessible: async () => destinationPage,
        move: () => pendingMove,
      })
      installController(sessionScope)
      const { queryClient } = renderPreviewWithToastStack()
      try {
        const dialog = await dispatchArchiveMove()
        expect(moveResource).toHaveBeenCalledWith(resourceId, 'destination-1', 'main', 7)
        expect(moveResource).toHaveBeenCalledTimes(1)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
        resolve.mockClear()

        expect(
          screen.queryByText('Couldn’t confirm the move. Refresh before trying again.')
        ).toBeNull()
        await act(async () => rejectMove(capturedTransportError))
        await waitFor(() => expect(resolve).toHaveBeenCalledTimes(1))

        expect(
          await screen.findByText(
            'diagram.png → Archive: Couldn’t confirm the move. Refresh before trying again.'
          )
        ).toBeTruthy()
        expect(screen.getByRole('status').className).toBe('toast tone-warn')
        expect(screen.queryByText(capturedTransportError.message)).toBeNull()
        expect(moveResource).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => rejectMove(capturedTransportError))
        queryClient.clear()
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('keeps a confirmed Move success visible when its resource refetch fails', async () => {
    let settleMove!: (receipt: MoveReceipt) => void
    const pendingMove = new Promise<MoveReceipt>(resolve => {
      settleMove = resolve
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource, resolve } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    const previewResourceKey = [...desktopQueryKeys.gfsRoot, sessionScope, 'preview-resource', uri]
    try {
      const dialog = await dispatchArchiveMove()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
      expect(screen.queryByText(moveMessage)).toBeNull()
      expect(queryClient.getQueryData(previewResourceKey)).toEqual(
        expect.objectContaining({ resourceId })
      )
      resolve.mockRejectedValue(new Error('preview refetch failed httpStatus=500'))

      await act(async () => {
        await expect(
          queryClient.refetchQueries(
            { queryKey: previewResourceKey, exact: true },
            { throwOnError: true }
          )
        ).rejects.toThrow('preview refetch failed')
      })
      expect(queryClient.getQueryState(previewResourceKey)?.status).toBe('error')
      const resourceUnavailableMenu = await openPreviewActions()
      expect(
        within(resourceUnavailableMenu).queryByRole('menuitem', { name: 'Move to' })
      ).toBeNull()
      fireEvent.keyDown(resourceUnavailableMenu, { key: 'Escape' })
      expect(screen.queryByText(moveMessage)).toBeNull()

      await act(async () => settleMove(successfulMoveReceipt))
      expect(queryClient.getQueryState(previewResourceKey)?.status).toBe('error')

      expect(await screen.findByText(moveMessage)).toBeTruthy()
      expect(screen.getAllByText(moveMessage)).toHaveLength(1)
      expect(resolve.mock.calls.length).toBeGreaterThan(1)
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => settleMove(successfulMoveReceipt))
      queryClient.clear()
    }
  })

  it('keeps a dispatched failure in the open dialog without duplicate toast feedback', async () => {
    let rejectMove!: (error: Error) => void
    const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectMove = reject
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    try {
      const dialog = await dispatchArchiveMove()
      await act(async () => rejectMove(new Error('Move rejected httpStatus=400')))

      expect(
        within(dialog).getByText(
          'The server rejected this destination. Refresh and choose a different folder.'
        )
      ).toBeTruthy()
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => rejectMove(new Error('Move rejected httpStatus=400')))
      queryClient.clear()
    }
  })

  it('does not dispatch or announce Move when the dialog closes during authorization', async () => {
    const permission = delegationAffordances(
      new Set(['read', 'write', 'delete', 'manage_acl', 'share']),
      false
    )
    let sourceReads = 0
    let resolveSource!: (value: typeof permission) => void
    const pendingSource = new Promise<typeof permission>(resolve => {
      resolveSource = resolve
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      source: () => (++sourceReads === 1 ? Promise.resolve(permission) : pendingSource),
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    try {
      await screen.findByAltText('Preview of diagram.png')
      const menu = await openPreviewActions()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
      await waitFor(() => expect(sourceReads).toBe(2))

      fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))
      await act(async () => resolveSource(permission))

      expect(moveResource).not.toHaveBeenCalled()
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
      expect(screen.queryByText(/Moved diagram\.png|Could not move diagram\.png/)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      await act(async () => resolveSource(permission))
      queryClient.clear()
    }
  })

  it.each(['session', 'resource'] as const)(
    'fences a settled result after the Preview %s context changes',
    async contextChange => {
      let settleMove!: (receipt: MoveReceipt) => void
      const pendingMove = new Promise<MoveReceipt>(resolve => {
        settleMove = resolve
      })
      const destinationPage = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', {
          permissions: ['read', 'write'],
        }),
      ])
      const { moveResource, resolve } = installGfs({
        destination: async () => fullAccess,
        listAccessible: async () => destinationPage,
        move: () => pendingMove,
      })
      installController(sessionScope)
      const { queryClient, rerender } = renderPreviewWithToastStack()
      const newScope = 'other-user:main'
      const currentScope = contextChange === 'session' ? newScope : sessionScope
      const currentUri = 'gfs://main/fedcba9876543210fedcba9876543210'
      const currentId = 'fedcba9876543210fedcba9876543210'
      const currentResource = resolveResource({
        resourceId: currentId,
        rid: currentId,
        gfsUri: currentUri,
        drive: 'main',
        parentResourceId: parentId,
        name: 'current.png',
        kind: 'file',
        version: 2,
        bytes: 1,
      })
      const currentCache = desktopQueryKeys.gfsChildren(currentScope, parentId, 'main')
      const capturedSessionCache = desktopQueryKeys.gfsChildren(sessionScope, parentId, 'main')
      queryClient.setQueryDefaults(currentCache, { gcTime: 60_000 })
      queryClient.setQueryDefaults(capturedSessionCache, { gcTime: 60_000 })
      queryClient.setQueryData(capturedSessionCache, { items: [], nextCursor: null })
      try {
        await dispatchArchiveMove()
        queryClient.setQueryData(currentCache, { items: [], nextCursor: null })

        if (contextChange === 'session') {
          installController(newScope)
          rerender(
            <QueryClientProvider client={queryClient}>
              <ToastingPreview />
            </QueryClientProvider>
          )
        } else {
          resolve.mockImplementation(async () => currentResource)
          rerender(
            <QueryClientProvider client={queryClient}>
              <ToastingPreview gfsUri={currentUri} fileName="current.png" />
            </QueryClientProvider>
          )
        }
        await screen.findByAltText(
          `Preview of ${contextChange === 'session' ? 'diagram.png' : 'current.png'}`
        )
        expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()

        await act(async () => settleMove(successfulMoveReceipt))

        expect(screen.queryByText(moveMessage)).toBeNull()
        expect(moveResource).toHaveBeenCalledTimes(1)
        if (contextChange === 'session') {
          expect(queryClient.getQueryState(currentCache)?.isInvalidated).toBe(false)
          expect(queryClient.getQueryState(capturedSessionCache)?.isInvalidated).toBe(false)
        } else {
          expect(queryClient.getQueryState(currentCache)?.isInvalidated).toBe(true)
        }
      } finally {
        await act(async () => settleMove(successfulMoveReceipt))
        queryClient.clear()
      }
    }
  )

  it.each(['session', 'resource'] as const)(
    'does not present a dispatched Move failure in a different Preview %s context',
    async contextChange => {
      const failureMessage = await gfsRouteFailureMessage(
        client =>
          client.moveResource(
            { resourceId, destinationId: 'destination-1', ifMatch: 7 },
            'fixture-session-token'
          ),
        412,
        { code: 'precondition_failed', message: 'stale file version' }
      )
      let rejectMove!: (error: Error) => void
      const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
        rejectMove = reject
      })
      const destinationPage = await listAccessiblePage([
        accessibleResource('destination-1', 'Archive', 'directory', {
          permissions: ['read', 'write'],
        }),
      ])
      const { moveResource, resolve } = installGfs({
        destination: async () => fullAccess,
        listAccessible: async () => destinationPage,
        move: () => pendingMove,
      })
      installController(sessionScope)
      const { queryClient, rerender } = renderPreviewWithToastStack()
      const newScope = 'other-user:main'
      const currentUri = 'gfs://main/fedcba9876543210fedcba9876543210'
      const currentId = 'fedcba9876543210fedcba9876543210'
      const currentResource = await resolveResource({
        resourceId: currentId,
        rid: currentId,
        gfsUri: currentUri,
        drive: 'main',
        parentResourceId: parentId,
        name: 'current.png',
        kind: 'file',
        version: 2,
        bytes: 1,
      })
      try {
        const dialog = await dispatchArchiveMove()
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))

        if (contextChange === 'session') {
          installController(newScope)
          rerender(
            <QueryClientProvider client={queryClient}>
              <ToastingPreview />
            </QueryClientProvider>
          )
        } else {
          resolve.mockResolvedValue(currentResource)
          rerender(
            <QueryClientProvider client={queryClient}>
              <ToastingPreview gfsUri={currentUri} fileName="current.png" />
            </QueryClientProvider>
          )
        }
        await screen.findByAltText(
          `Preview of ${contextChange === 'session' ? 'diagram.png' : 'current.png'}`
        )
        await act(async () => rejectMove(new Error(failureMessage)))

        expect(screen.queryByText(/This item changed while you were moving it/)).toBeNull()
        expect(screen.queryByText(failureMessage)).toBeNull()
        expect(screen.queryByRole('alert')).toBeNull()
        expect(moveResource).toHaveBeenCalledTimes(1)
      } finally {
        await act(async () => rejectMove(new Error(failureMessage)))
        queryClient.clear()
      }
    }
  )

  it('does not apply a stale Move 401 to the new Preview session', async () => {
    const failureMessage = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          { resourceId, destinationId: 'destination-1', ifMatch: 7 },
          'fixture-session-token'
        ),
      401,
      { code: 'unauthorized', message: 'not authenticated' }
    )
    let rejectMove!: (error: Error) => void
    const pendingMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectMove = reject
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    const oldSessionAuthorityFailure = installController(sessionScope)
    const { queryClient, rerender } = renderPreviewWithToastStack()
    const newScope = 'other-user:main'
    const newSessionAuthorityFailure = vi.fn(() => false)
    try {
      const dialog = await dispatchArchiveMove()
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close move dialog' }))

      hookMock.useGfsBrowserController.mockReturnValue({
        accessState: 'active',
        sessionScope: newScope,
        authorityPending: false,
        handleAuthorityFailure: newSessionAuthorityFailure,
      })
      rerender(
        <QueryClientProvider client={queryClient}>
          <ToastingPreview />
        </QueryClientProvider>
      )
      await screen.findByAltText('Preview of diagram.png')

      await act(async () => rejectMove(new Error(failureMessage)))

      expect(oldSessionAuthorityFailure).not.toHaveBeenCalled()
      expect(newSessionAuthorityFailure).not.toHaveBeenCalled()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => rejectMove(new Error(failureMessage)))
      queryClient.clear()
    }
  })

  it('does not dispatch a pending Preview Move after its owner unmounts', async () => {
    let sourceReads = 0
    let releaseSource!: (value: ReturnType<typeof delegationAffordances>) => void
    const pendingSource = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      releaseSource = resolve
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource, affordances, resolve } = installGfs({
      source: () => (++sourceReads === 1 ? Promise.resolve(fullAccess) : pendingSource),
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
    })
    installController(sessionScope)
    const { queryClient, rerender } = renderPreviewWithToastStack()
    try {
      await screen.findByAltText('Preview of diagram.png')
      const menu = await openPreviewActions()
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move to' }))
      const dialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(dialog).findByRole('button', { name: 'Archive' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Move here (Archive)' }))
      await waitFor(() => expect(sourceReads).toBe(2))
      expect(moveResource).not.toHaveBeenCalled()
      const affordanceReadsBeforeUnmount = affordances.mock.calls.length
      const resolveReadsBeforeUnmount = resolve.mock.calls.length

      rerender(
        <QueryClientProvider client={queryClient}>
          <ToastingPreview showPreview={false} />
        </QueryClientProvider>
      )
      await act(async () => releaseSource(fullAccess))

      expect(moveResource).not.toHaveBeenCalled()
      expect(affordances).toHaveBeenCalledTimes(affordanceReadsBeforeUnmount)
      expect(resolve).toHaveBeenCalledTimes(resolveReadsBeforeUnmount)
      expect(screen.queryByText(moveMessage)).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
    } finally {
      await act(async () => releaseSource(fullAccess))
      queryClient.clear()
    }
  })

  it('does not let an earlier completion close a newer Move dialog or misattribute results', async () => {
    let settleArchive!: (receipt: MoveReceipt) => void
    let settleWork!: (receipt: MoveReceipt) => void
    const archiveMove = new Promise<MoveReceipt>(resolve => {
      settleArchive = resolve
    })
    const workMove = new Promise<MoveReceipt>(resolve => {
      settleWork = resolve
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-2', 'Work', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      listAccessible: async () => destinationPage,
      move: (_resourceId, destinationId) =>
        destinationId === 'destination-1' ? archiveMove : workMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    try {
      await screen.findByAltText('Preview of diagram.png')
      const firstMenu = await openPreviewActions()
      fireEvent.click(within(firstMenu).getByRole('menuitem', { name: 'Move to' }))
      const firstDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(firstDialog).findByRole('button', { name: 'Archive' }))
      await fireEvent.click(
        within(firstDialog).getByRole('button', { name: 'Move here (Archive)' })
      )
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(1))
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Close move dialog' }))

      const secondMenu = await openPreviewActions()
      fireEvent.click(within(secondMenu).getByRole('menuitem', { name: 'Move to' }))
      const secondDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(secondDialog).findByRole('button', { name: 'Work' }))
      await fireEvent.click(within(secondDialog).getByRole('button', { name: 'Move here (Work)' }))
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(2))
      expect(moveResource.mock.calls[0]).toEqual([resourceId, 'destination-1', 'main', 7])
      expect(moveResource.mock.calls[1]).toEqual([resourceId, 'destination-2', 'main', 7])

      await act(async () => settleArchive(successfulMoveReceipt))
      expect(await screen.findByText('Moved diagram.png to Archive')).toBeTruthy()
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBeTruthy()
      expect(screen.queryByText('Moved diagram.png to Work')).toBeNull()

      await act(async () => settleWork(successfulMoveReceipt))
      expect(await screen.findByText('Moved diagram.png to Work')).toBeTruthy()
      expect(screen.queryByRole('dialog', { name: 'Move file diagram.png' })).toBeNull()
      expect(screen.getAllByRole('status')).toHaveLength(2)
      expect(moveResource).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => {
        settleArchive(successfulMoveReceipt)
        settleWork(successfulMoveReceipt)
      })
      queryClient.clear()
    }
  })

  it('keeps a dispatched success when its own refresh advances the resource version', async () => {
    let settleArchive!: (receipt: MoveReceipt) => void
    let settleWork!: (receipt: MoveReceipt) => void
    let finishPermissionRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    let holdPermissionRefresh = false
    let sourceReads = 0
    const archiveMove = new Promise<MoveReceipt>(resolve => {
      settleArchive = resolve
    })
    const workMove = new Promise<MoveReceipt>(resolve => {
      settleWork = resolve
    })
    const permissionRefresh = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      finishPermissionRefresh = resolve
    })
    const movedResource = await resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'destination-1',
      name: 'diagram.png',
      kind: 'file',
      version: 8,
      bytes: 1,
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-2', 'Work', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource, resolve } = installGfs({
      source: () => {
        sourceReads += 1
        return holdPermissionRefresh ? permissionRefresh : Promise.resolve(fullAccess)
      },
      listAccessible: async () => destinationPage,
      move: (_id, destinationId) => (destinationId === 'destination-1' ? archiveMove : workMove),
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    const previewResourceKey = [...desktopQueryKeys.gfsRoot, sessionScope, 'preview-resource', uri]
    try {
      const archiveDialog = await dispatchArchiveMove()
      fireEvent.click(within(archiveDialog).getByRole('button', { name: 'Close move dialog' }))

      const workMenu = await openPreviewActions()
      fireEvent.click(within(workMenu).getByRole('menuitem', { name: 'Move to' }))
      const workDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(workDialog).findByRole('button', { name: 'Work' }))
      await fireEvent.click(within(workDialog).getByRole('button', { name: 'Move here (Work)' }))
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(2))
      expect(moveResource.mock.calls).toEqual([
        [resourceId, 'destination-1', 'main', 7],
        [resourceId, 'destination-2', 'main', 7],
      ])

      holdPermissionRefresh = true
      resolve.mockResolvedValue(movedResource)
      await act(async () => settleArchive(successfulMoveReceipt))
      await waitFor(() => expect(sourceReads).toBeGreaterThan(3))
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(4))
      await waitFor(() =>
        expect(queryClient.getQueryData(previewResourceKey)).toEqual(movedResource)
      )
      expect(screen.queryByText('Moved diagram.png to Archive')).toBeNull()

      await act(async () => finishPermissionRefresh(fullAccess))
      expect(await screen.findByText('Moved diagram.png to Archive')).toBeTruthy()
      expect(screen.getAllByText('Moved diagram.png to Archive')).toHaveLength(1)
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBeTruthy()
      expect(moveResource).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => {
        settleArchive(successfulMoveReceipt)
        settleWork(successfulMoveReceipt)
        finishPermissionRefresh(fullAccess)
      })
      queryClient.clear()
    }
  })

  it('shows a competing stale-version failure in the still-current Move dialog', async () => {
    const failureMessage = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          { resourceId, destinationId: 'destination-2', ifMatch: 7 },
          'fixture-session-token'
        ),
      412,
      { code: 'precondition_failed', message: 'stale file version' }
    )
    let settleArchive!: (receipt: MoveReceipt) => void
    let rejectWork!: (error: Error) => void
    let finishPermissionRefresh!: (value: ReturnType<typeof delegationAffordances>) => void
    let holdPermissionRefresh = false
    let sourceReads = 0
    const archiveMove = new Promise<MoveReceipt>(resolve => {
      settleArchive = resolve
    })
    const workMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectWork = reject
    })
    const permissionRefresh = new Promise<ReturnType<typeof delegationAffordances>>(resolve => {
      finishPermissionRefresh = resolve
    })
    const movedResource = await resolveResource({
      resourceId,
      rid: resourceId,
      gfsUri: uri,
      drive: 'main',
      parentResourceId: 'destination-1',
      name: 'diagram.png',
      kind: 'file',
      version: 8,
      bytes: 1,
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-2', 'Work', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource, resolve } = installGfs({
      source: () => {
        sourceReads += 1
        return holdPermissionRefresh ? permissionRefresh : Promise.resolve(fullAccess)
      },
      listAccessible: async () => destinationPage,
      move: (_id, destinationId) => (destinationId === 'destination-1' ? archiveMove : workMove),
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    try {
      const archiveDialog = await dispatchArchiveMove()
      fireEvent.click(within(archiveDialog).getByRole('button', { name: 'Close move dialog' }))

      const workMenu = await openPreviewActions()
      fireEvent.click(within(workMenu).getByRole('menuitem', { name: 'Move to' }))
      const workDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(workDialog).findByRole('button', { name: 'Work' }))
      await fireEvent.click(within(workDialog).getByRole('button', { name: 'Move here (Work)' }))
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(2))
      expect(moveResource.mock.calls).toEqual([
        [resourceId, 'destination-1', 'main', 7],
        [resourceId, 'destination-2', 'main', 7],
      ])

      holdPermissionRefresh = true
      resolve.mockResolvedValue(movedResource)
      await act(async () => settleArchive(successfulMoveReceipt))
      await waitFor(() => expect(sourceReads).toBeGreaterThan(3))
      await waitFor(() => expect(resolve).toHaveBeenCalledTimes(4))
      await waitFor(() =>
        expect(
          queryClient.getQueryData([
            ...desktopQueryKeys.gfsRoot,
            sessionScope,
            'preview-resource',
            uri,
          ])
        ).toEqual(movedResource)
      )

      await act(async () => rejectWork(new Error(failureMessage)))
      expect(
        within(workDialog).getByText(
          'This item changed while you were moving it. Review its current location and try again.'
        )
      ).toBeTruthy()
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(moveResource).toHaveBeenCalledTimes(2)

      await act(async () => finishPermissionRefresh(fullAccess))
      expect(await screen.findByText('Moved diagram.png to Archive')).toBeTruthy()
    } finally {
      await act(async () => {
        settleArchive(successfulMoveReceipt)
        rejectWork(new Error(failureMessage))
        finishPermissionRefresh(fullAccess)
      })
      queryClient.clear()
    }
  })

  it('identifies the captured destination for overlapping post-close Move failures', async () => {
    const failureMessage = await gfsRouteFailureMessage(
      client =>
        client.moveResource(
          { resourceId, destinationId: 'destination-1', ifMatch: 7 },
          'fixture-session-token'
        ),
      400,
      { code: 'invalid_destination', message: 'invalid parent' }
    )
    let rejectArchive!: (error: Error) => void
    let rejectWork!: (error: Error) => void
    const archiveMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectArchive = reject
    })
    const workMove = new Promise<MoveReceipt>((_resolve, reject) => {
      rejectWork = reject
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
      accessibleResource('destination-2', 'Work', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      listAccessible: async () => destinationPage,
      move: (_resourceId, destinationId) =>
        destinationId === 'destination-1' ? archiveMove : workMove,
    })
    installController(sessionScope)
    const { queryClient } = renderPreviewWithToastStack()
    const sourceChildrenKey = desktopQueryKeys.gfsChildren(sessionScope, parentId, 'main')
    queryClient.setQueryDefaults(sourceChildrenKey, { gcTime: 60_000 })
    queryClient.setQueryData(sourceChildrenKey, { items: [], nextCursor: null })
    try {
      await screen.findByAltText('Preview of diagram.png')
      const archiveMenu = await openPreviewActions()
      fireEvent.click(within(archiveMenu).getByRole('menuitem', { name: 'Move to' }))
      const archiveDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(archiveDialog).findByRole('button', { name: 'Archive' }))
      await fireEvent.click(
        within(archiveDialog).getByRole('button', { name: 'Move here (Archive)' })
      )
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(1))
      fireEvent.click(within(archiveDialog).getByRole('button', { name: 'Close move dialog' }))

      const workMenu = await openPreviewActions()
      fireEvent.click(within(workMenu).getByRole('menuitem', { name: 'Move to' }))
      const workDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      await fireEvent.click(await within(workDialog).findByRole('button', { name: 'Work' }))
      await fireEvent.click(within(workDialog).getByRole('button', { name: 'Move here (Work)' }))
      await waitFor(() => expect(moveResource).toHaveBeenCalledTimes(2))
      expect(moveResource.mock.calls[0]).toEqual([resourceId, 'destination-1', 'main', 7])
      expect(moveResource.mock.calls[1]).toEqual([resourceId, 'destination-2', 'main', 7])
      fireEvent.click(within(workDialog).getByRole('button', { name: 'Close move dialog' }))

      const newerMenu = await openPreviewActions()
      fireEvent.click(within(newerMenu).getByRole('menuitem', { name: 'Move to' }))
      const newerDialog = await screen.findByRole('dialog', { name: 'Move file diagram.png' })
      expect(screen.queryByRole('alert')).toBeNull()
      expect(queryClient.getQueryState(sourceChildrenKey)?.isInvalidated).toBe(false)
      await act(async () => rejectArchive(new Error(failureMessage)))
      const archiveFailure = await screen.findByRole('alert')
      expect(archiveFailure.className).toBe('toast tone-error')
      expect(archiveFailure.textContent).toContain('diagram.png')
      expect(archiveFailure.textContent).toContain('Archive')
      expect(archiveFailure.textContent).toContain(
        'The server rejected this destination. Refresh and choose a different folder.'
      )
      expect(screen.getAllByRole('alert')).toHaveLength(1)
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBe(newerDialog)
      expect(queryClient.getQueryState(sourceChildrenKey)?.isInvalidated).toBe(false)

      await act(async () => rejectWork(new Error(failureMessage)))
      await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2))
      const failures = screen.getAllByRole('alert')
      expect(failures.map(alert => alert.textContent)).toEqual([
        expect.stringContaining('Archive'),
        expect.stringContaining('Work'),
      ])
      expect(failures.every(alert => alert.className === 'toast tone-error')).toBe(true)
      expect(failures.every(alert => alert.textContent?.includes('diagram.png'))).toBe(true)
      expect(
        failures.every(alert =>
          alert.textContent?.includes(
            'The server rejected this destination. Refresh and choose a different folder.'
          )
        )
      ).toBe(true)
      expect(screen.getByRole('dialog', { name: 'Move file diagram.png' })).toBe(newerDialog)
      expect(screen.queryByText(failureMessage)).toBeNull()
      expect(queryClient.getQueryState(sourceChildrenKey)?.isInvalidated).toBe(false)
      expect(moveResource).toHaveBeenCalledTimes(2)
    } finally {
      await act(async () => {
        rejectArchive(new Error(failureMessage))
        rejectWork(new Error(failureMessage))
      })
      queryClient.clear()
    }
  })

  it('invalidates the same-session cache but does not toast after Preview unmounts', async () => {
    let settleMove!: (receipt: MoveReceipt) => void
    const pendingMove = new Promise<MoveReceipt>(resolve => {
      settleMove = resolve
    })
    const destinationPage = await listAccessiblePage([
      accessibleResource('destination-1', 'Archive', 'directory', {
        permissions: ['read', 'write'],
      }),
    ])
    const { moveResource } = installGfs({
      destination: async () => fullAccess,
      listAccessible: async () => destinationPage,
      move: () => pendingMove,
    })
    installController(sessionScope)
    const { queryClient, rerender } = renderPreviewWithToastStack()
    const cacheKey = desktopQueryKeys.gfsChildren(sessionScope, parentId, 'main')
    queryClient.setQueryDefaults(cacheKey, { gcTime: 60_000 })
    try {
      await dispatchArchiveMove()
      queryClient.setQueryData(cacheKey, { items: [], nextCursor: null })
      expect(queryClient.getQueryState(cacheKey)?.isInvalidated).toBe(false)

      rerender(
        <QueryClientProvider client={queryClient}>
          <ToastingPreview showPreview={false} />
        </QueryClientProvider>
      )
      await act(async () => settleMove(successfulMoveReceipt))

      expect(queryClient.getQueryState(cacheKey)?.isInvalidated).toBe(true)
      expect(screen.queryByText(moveMessage)).toBeNull()
      expect(screen.queryByRole('status')).toBeNull()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(moveResource).toHaveBeenCalledTimes(1)
    } finally {
      await act(async () => settleMove(successfulMoveReceipt))
      queryClient.clear()
    }
  })
})
