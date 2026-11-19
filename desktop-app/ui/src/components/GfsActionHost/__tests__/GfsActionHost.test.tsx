// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { desktopQueryKeys } from '@hooks/domain/queryKeys'
import { useGfsWatchSubscription } from '@hooks/domain/useGfsWatchSubscription'
import { revokeGfsSessionAccess } from '@lib/gfsSessionAuthority'
import { purgeGfsSessionCache, refetchGfsAccess } from '@lib/gfsWatchReaction'
import { desktopQueryDefaults } from '@lib/queryClient'
import {
  childView,
  createFolderResult,
  downloadResult,
  gfsRouteFailureMessage,
  grantsListPage,
  listAccessiblePage,
  listChildrenPage,
  listGrantsFailureMessage,
  moveResourceReceipt,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import { GfsActionHost } from '..'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { useGfsActionHost } from '../context'
import type { GfsActionHostContextValue, GfsHostActionTarget } from '../types'

const SCOPE = ':user-a:team-a'
const me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member',
}

type Affordances = Awaited<ReturnType<typeof delegationAffordances>>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const editor = () =>
  delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl', 'share']), false)
const readOnly = () => delegationAffordances(new Set(['read']), false)

/** A listing row as the tree holds it: produced by the real listChildren path. */
async function listedRow(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  parentResourceId: string | null = 'folder-p'
): Promise<GfsHostActionTarget> {
  const page = await listChildrenPage([
    childView(resourceId, name, kind, { parentResourceId, version: 3 }),
  ])
  return page.items[0] as GfsHostActionTarget
}

interface Bridge {
  getSessionGeneration: ReturnType<typeof vi.fn>
  affordances: ReturnType<typeof vi.fn>
  renameResource: ReturnType<typeof vi.fn>
  createFolder: ReturnType<typeof vi.fn>
  deleteResource: ReturnType<typeof vi.fn>
  createFileFromPath: ReturnType<typeof vi.fn>
  moveResource: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
  listAccessible: ReturnType<typeof vi.fn>
  listChildren: ReturnType<typeof vi.fn>
  listGrants: ReturnType<typeof vi.fn>
  listShares: ReturnType<typeof vi.fn>
  download: ReturnType<typeof vi.fn>
  grant: ReturnType<typeof vi.fn>
  revokeGrant: ReturnType<typeof vi.fn>
}

interface Harness {
  client: QueryClient
  bridge: Bridge
  toasts: Array<{ message: string; tone: string }>
  overlay: boolean[]
  refreshFilesLocation: ReturnType<typeof vi.fn>
  host: () => GfsActionHostContextValue
  /** What main runs now; the renderer publishes it later (`publish`). */
  main: { generation: number }
  publish: (generation: number | null) => void
  open: (
    target: GfsHostActionTarget,
    actionId: Parameters<GfsActionHostContextValue['openGfsAction']>[1]
  ) => void
}

const mutationCalls = (h: Harness) =>
  h.bridge.renameResource.mock.calls.length +
  h.bridge.createFolder.mock.calls.length +
  h.bridge.deleteResource.mock.calls.length +
  h.bridge.createFileFromPath.mock.calls.length +
  h.bridge.moveResource.mock.calls.length

async function harness(
  options: {
    affordances?: (resourceId: string) => Promise<Affordances>
    gfsWatch?: Window['clerum']['gfsWatch']
    myAgents?: unknown[]
  } = {}
): Promise<Harness> {
  const main = { generation: 1 }
  const renamed = await renameResourceResult('file-t', 'renamed.txt', 4)
  const created = await createFolderResult('folder-d', childView('new-1', 'Reports', 'directory'))
  const emptyGrants = await grantsListPage([])
  const emptyShares = await sharesListPage([])
  const roots = await listAccessiblePage([])
  const bridge: Bridge = {
    getSessionGeneration: vi.fn(async () => main.generation),
    affordances: vi.fn(options.affordances ?? (async () => editor())),
    renameResource: vi.fn(async () => renamed),
    createFolder: vi.fn(async () => created),
    deleteResource: vi.fn(async () => undefined),
    createFileFromPath: vi.fn(async () => created),
    moveResource: vi.fn(),
    resolve: vi.fn(),
    listAccessible: vi.fn(async () => roots),
    listChildren: vi.fn(async () => listChildrenPage([])),
    listGrants: vi.fn(async () => emptyGrants),
    listShares: vi.fn(async () => emptyShares),
    download: vi.fn(),
    grant: vi.fn(async () => undefined),
    revokeGrant: vi.fn(async () => undefined),
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: bridge.getSessionGeneration },
      gfs: {
        ...bridge,
        getSessionGeneration: undefined,
        getPathForFile: (file: File) => `/local/${file.name}`,
      },
      team: { directory: vi.fn(async () => ({ items: [] })) },
      agents: { listMine: vi.fn(async () => options.myAgents ?? []) },
      ...(options.gfsWatch ? { gfsWatch: options.gfsWatch } : {}),
    },
  })
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const toasts: Harness['toasts'] = []
  const overlay: boolean[] = []
  const refreshFilesLocation = vi.fn()
  let hostValue: GfsActionHostContextValue | null = null
  let setGeneration!: (generation: number | null) => void

  function Probe() {
    hostValue = useGfsActionHost()
    return null
  }
  // What App does with the watch events the host depends on.
  function WatchRouting() {
    useGfsWatchSubscription({
      keys: [],
      userId: null,
      sessionKey: 'session',
      onEvent: event => {
        const authority = { scope: SCOPE, generation: 1 }
        if (event.type === 'accessChanged') void refetchGfsAccess(client, authority)
        if (event.type === 'sessionExpired') purgeGfsSessionCache(client, authority)
      },
    })
    return null
  }
  function Root() {
    const [generation, setGen] = useState<number | null>(1)
    setGeneration = setGen
    const auth = {
      isAuthenticated: generation !== null,
      me: generation !== null ? me : null,
      runtimeConfigState: null,
      sessionGeneration: generation,
    } as unknown as AuthContextValue
    return (
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          {options.gfsWatch ? <WatchRouting /> : null}
          <GfsActionHost
            pushToast={(message, tone) => toasts.push({ message, tone })}
            refreshFilesLocation={refreshFilesLocation}
            onActionOpenChange={open => overlay.push(open)}
          >
            <Probe />
          </GfsActionHost>
        </QueryClientProvider>
      </AuthContext.Provider>
    )
  }
  render(<Root />)
  const host = () => {
    if (!hostValue) throw new Error('host not mounted')
    return hostValue
  }
  return {
    client,
    bridge,
    toasts,
    overlay,
    refreshFilesLocation,
    host,
    main,
    publish: generation => act(() => setGeneration(generation)),
    open: (target, actionId) => act(() => host().openGfsAction(target, actionId)),
  }
}

const revoke = (h: Harness) => revokeGfsSessionAccess(h.client, SCOPE, 1)
const dialog = () => screen.queryByRole('dialog')
const overlayOpen = (h: Harness) => h.overlay[h.overlay.length - 1] ?? false
const toastMessages = (h: Harness) => h.toasts.map(toast => toast.message)

/** Opens Rename on `target` and waits for its dialog. */
async function openRename(h: Harness, target: GfsHostActionTarget) {
  h.open(target, 'rename')
  await waitFor(() => expect(screen.getByRole('dialog', { name: /rename file/i })).toBeTruthy())
}

function typeName(value: string) {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value } })
}

/** Makes the next submit re-read the target's authority from the server. */
function expireAuthority(h: Harness, resourceId: string) {
  void h.client.invalidateQueries({
    queryKey: desktopQueryKeys.gfsAffordances(SCOPE, resourceId, 'main', 1),
    refetchType: 'none',
  })
}

afterEach(() => {
  cleanup()
  delete (window as { clerum?: unknown }).clerum
})

describe('GfsActionHost — opening an action', () => {
  it('S-2: a revocation during the opening check opens no dialog and runs nothing', async () => {
    const check = deferred<Affordances>()
    const h = await harness({ affordances: () => check.promise })
    const target = await listedRow('file-t', 'notes.txt', 'file')

    h.open(target, 'rename')
    expect(overlayOpen(h)).toBe(true)
    await waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(1))
    act(() => revoke(h))
    await act(async () => check.resolve(await editor()))

    await waitFor(() => expect(overlayOpen(h)).toBe(false))
    expect(dialog()).toBeNull()
    expect(mutationCalls(h)).toBe(0)
    // The revoked session's own surface is the feedback: no permission toast.
    expect(h.toasts).toEqual([])
  })

  it('S-2 (denial): the opening check toasts the missing permission and opens nothing', async () => {
    const h = await harness({ affordances: async () => readOnly() })
    const target = await listedRow('file-t', 'notes.txt', 'file')

    h.open(target, 'rename')

    await waitFor(() =>
      expect(toastMessages(h)).toEqual(['You do not have write access to notes.txt.'])
    )
    expect(dialog()).toBeNull()
    expect(overlayOpen(h)).toBe(false)
  })

  it('S-13: an action chosen during the opening check replaces it; the first opens nothing', async () => {
    const first = deferred<Affordances>()
    const second = deferred<Affordances>()
    const h = await harness({
      affordances: resourceId => (resourceId === 'file-t' ? first.promise : second.promise),
    })
    const renameTarget = await listedRow('file-t', 'notes.txt', 'file')
    const deleteTarget = await listedRow('file-u', 'draft.txt', 'file')

    h.open(renameTarget, 'rename')
    h.open(deleteTarget, 'delete')
    await act(async () => first.resolve(await editor()))
    await act(async () => {})
    expect(screen.queryByRole('dialog', { name: /rename/i })).toBeNull()

    await act(async () => second.resolve(await editor()))
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Delete draft.txt?' })).toBeTruthy()
    )
    expect(screen.queryByRole('dialog', { name: /rename/i })).toBeNull()
    expect(overlayOpen(h)).toBe(true)
  })

  it('copy and download run without a dialog and leave the active action alone', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    const copyDeepLink = vi.fn(async () => ({ url: 'https://example.test/l' }))
    ;(window.clerum.gfs as { copyDeepLink?: unknown }).copyDeepLink = copyDeepLink

    await act(async () => h.host().openGfsAction(target, 'copy-link'))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Shareable EvenDrive link copied']))
    expect(copyDeepLink).toHaveBeenCalledWith('gfs://main/file-t')
    expect(h.overlay).toEqual([])
    expect(h.bridge.listAccessible).not.toHaveBeenCalled()
  })
})

describe('GfsActionHost — submitting', () => {
  it('renames the chosen target, refreshes the Files location and toasts once (K1)', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Renamed to renamed.txt']))
    await waitFor(() => expect(dialog()).toBeNull())
    expect(h.bridge.renameResource).toHaveBeenCalledTimes(1)
    expect(h.bridge.renameResource).toHaveBeenCalledWith('file-t', 'renamed.txt', 'main', 3)
    expect(h.refreshFilesLocation).toHaveBeenCalledTimes(1)
    expect(overlayOpen(h)).toBe(false)
    // One authority read to open, one main check before the rename and one before the toast.
    expect(h.bridge.affordances).toHaveBeenCalledTimes(1)
    expect(h.bridge.getSessionGeneration).toHaveBeenCalledTimes(2)
    expect(h.bridge.listAccessible).not.toHaveBeenCalled()
  })

  for (const event of ['revocation', 'team switch in main', 'logout'] as const) {
    it(`S-3: a ${event} during the submit's permission read starts no mutation`, async () => {
      const h = await harness()
      const target = await listedRow('file-t', 'notes.txt', 'file')
      await openRename(h, target)
      const reread = deferred<Affordances>()
      h.bridge.affordances.mockImplementation(() => reread.promise)
      expireAuthority(h, 'file-t')

      typeName('renamed.txt')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(2))
      act(() => {
        if (event === 'revocation') revoke(h)
        else if (event === 'team switch in main') h.main.generation = 2
        else h.client.clear()
      })
      await act(async () => reread.resolve(await editor()))

      await waitFor(() => expect(dialog()).toBeNull())
      expect(mutationCalls(h)).toBe(0)
      expect(h.refreshFilesLocation).not.toHaveBeenCalled()
      expect(toastMessages(h)).not.toContain('Renamed to renamed.txt')
    })
  }

  it('S-3 (control): the same submit with no event renames', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    const reread = deferred<Affordances>()
    h.bridge.affordances.mockImplementation(() => reread.promise)
    expireAuthority(h, 'file-t')

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(2))
    await act(async () => reread.resolve(await editor()))

    await waitFor(() => expect(h.bridge.renameResource).toHaveBeenCalledTimes(1))
  })

  it('S-3b: a revocation in the same tick as the submit, before any effect runs, starts nothing', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    typeName('renamed.txt')
    const save = screen.getByRole('button', { name: 'Save' })

    act(() => {
      revoke(h)
      save.click()
    })

    await waitFor(() => expect(dialog()).toBeNull())
    expect(mutationCalls(h)).toBe(0)
  })

  it('S-3c: main on a new generation while the renderer still publishes the old one starts nothing', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    h.main.generation = 2

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(dialog()).toBeNull())
    expect(h.bridge.getSessionGeneration).toHaveBeenCalled()
    expect(mutationCalls(h)).toBe(0)
  })

  it('S-4: a mutation that lands after a session switch shows no toast in the new session', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    const landed = deferred<Awaited<ReturnType<typeof renameResourceResult>>>()
    h.bridge.renameResource.mockImplementation(() => landed.promise)

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.bridge.renameResource).toHaveBeenCalledTimes(1))
    h.main.generation = 2
    await act(async () => landed.resolve(await renameResourceResult('file-t', 'renamed.txt', 4)))

    await waitFor(() => expect(dialog()).toBeNull())
    expect(h.toasts).toEqual([])
  })

  it('S-4: an answer main gave before a switch shows no toast once the renderer publishes the new generation', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    const landed = deferred<Awaited<ReturnType<typeof renameResourceResult>>>()
    h.bridge.renameResource.mockImplementation(() => landed.promise)
    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.bridge.renameResource).toHaveBeenCalledTimes(1))
    // Main answers the last check under the old generation, and the answer
    // arrives only after the same team was published under a newer one.
    const lastCheck = deferred<number>()
    h.bridge.getSessionGeneration.mockImplementationOnce(() => lastCheck.promise)

    await act(async () => landed.resolve(await renameResourceResult('file-t', 'renamed.txt', 4)))
    await waitFor(() => expect(h.bridge.getSessionGeneration).toHaveBeenCalledTimes(2))
    h.main.generation = 2
    h.publish(2)
    await act(async () => lastCheck.resolve(1))
    await act(async () => {})

    expect(h.toasts).toEqual([])
  })

  it('S-4 (control): the same mutation in the same session toasts its success', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)
    const landed = deferred<Awaited<ReturnType<typeof renameResourceResult>>>()
    h.bridge.renameResource.mockImplementation(() => landed.promise)

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.bridge.renameResource).toHaveBeenCalledTimes(1))
    await act(async () => landed.resolve(await renameResourceResult('file-t', 'renamed.txt', 4)))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Renamed to renamed.txt']))
  })

  it('S-5: a 412 is shown in the dialog with the captured version, and never retried', async () => {
    const stale = await gfsRouteFailureMessage(
      client =>
        client.renameResource(
          { resourceId: 'file-t', drive: 'main', newName: 'renamed.txt', ifMatch: 3 },
          'fixture-session-token'
        ),
      412,
      { code: 'version_conflict', message: 'the resource changed since it was read' }
    )
    const h = await harness()
    h.bridge.renameResource.mockRejectedValue(new Error(stale))
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)

    typeName('renamed.txt')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    const shown = await screen.findByRole('dialog', { name: /rename file/i })
    await waitFor(() =>
      expect(within(shown).getByText(/the resource changed since it was read/)).toBeTruthy()
    )
    expect(h.bridge.renameResource).toHaveBeenCalledTimes(1)
    expect(h.bridge.renameResource).toHaveBeenCalledWith('file-t', 'renamed.txt', 'main', 3)
    expect(h.refreshFilesLocation).not.toHaveBeenCalled()
  })

  it('deletes after the confirmation and closes', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    h.open(target, 'delete')
    await screen.findByRole('dialog', { name: 'Delete notes.txt?' })

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Deleted notes.txt']))
    expect(h.bridge.deleteResource).toHaveBeenCalledWith('file-t', 'main', 3)
    expect(dialog()).toBeNull()
  })

  it('creates a folder in the chosen folder', async () => {
    const h = await harness()
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    h.open(folder, 'new-folder')
    await screen.findByRole('dialog', { name: 'New folder' })

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Reports' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Folder Reports created']))
    expect(h.bridge.createFolder).toHaveBeenCalledWith('folder-d', 'Reports', 'main')
  })
})

describe('GfsActionHost — revocation of an open action', () => {
  it('S-3d: a real sessionExpired from the watch closes an open dialog; nothing runs', async () => {
    const source = await new GfsWatchEventSource().start()
    try {
      const watch = source.connectRenderer()
      const h = await harness({ gfsWatch: watch.bridge })
      await waitFor(() => expect(watch.opens).toBe(1))
      const target = await listedRow('file-t', 'notes.txt', 'file')
      await openRename(h, target)

      await act(async () => {
        await source.sessionExpired()
      })

      await waitFor(() => expect(dialog()).toBeNull())
      expect(overlayOpen(h)).toBe(false)
      expect(mutationCalls(h)).toBe(0)
    } finally {
      await source.stop()
    }
  })

  it('S-3d: a sessionExpired during the submit permission read stops the mutation', async () => {
    const source = await new GfsWatchEventSource().start()
    try {
      const watch = source.connectRenderer()
      const h = await harness({ gfsWatch: watch.bridge })
      await waitFor(() => expect(watch.opens).toBe(1))
      const target = await listedRow('file-t', 'notes.txt', 'file')
      await openRename(h, target)
      const reread = deferred<Affordances>()
      h.bridge.affordances.mockImplementation(() => reread.promise)
      expireAuthority(h, 'file-t')
      typeName('renamed.txt')
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(h.bridge.affordances).toHaveBeenCalledTimes(2))

      await act(async () => {
        await source.sessionExpired()
      })
      await act(async () => reread.resolve(await editor()))

      await waitFor(() => expect(dialog()).toBeNull())
      expect(mutationCalls(h)).toBe(0)
    } finally {
      await source.stop()
    }
  })

  it('closes an open dialog when the renderer publishes another session', async () => {
    const h = await harness()
    const target = await listedRow('file-t', 'notes.txt', 'file')
    await openRename(h, target)

    h.publish(2)

    await waitFor(() => expect(dialog()).toBeNull())
    expect(overlayOpen(h)).toBe(false)
  })
})

describe('GfsActionHost — upload', () => {
  const file = () => new File(['data'], 'report.txt', { type: 'text/plain' })
  const pick = (selected: File | null) =>
    fireEvent.change(screen.getByTestId('gfs-action-host-upload-input'), {
      target: { files: selected ? [selected] : [] },
    })

  it('S-6 (positive): opens the picker inside the gesture and uploads into the folder', async () => {
    const h = await harness()
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    expect(click).toHaveBeenCalledTimes(1)
    expect(overlayOpen(h)).toBe(true)
    await act(async () => pick(file()))

    await waitFor(() => expect(toastMessages(h)).toEqual(['Uploaded report.txt']))
    expect(h.bridge.createFileFromPath).toHaveBeenCalledWith(
      'folder-d',
      'report.txt',
      '/local/report.txt',
      'main'
    )
    expect(overlayOpen(h)).toBe(false)
    click.mockRestore()
  })

  it('S-6: a revocation with the picker open closes the action; the chosen file is dropped', async () => {
    const h = await harness()
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    act(() => revoke(h))
    await waitFor(() => expect(overlayOpen(h)).toBe(false))
    await act(async () => pick(file()))
    await act(async () => {})

    expect(h.bridge.createFileFromPath).not.toHaveBeenCalled()
    expect(h.toasts).toEqual([])
    click.mockRestore()
  })

  it('S-6: a revocation between name retries stops the next create', async () => {
    const conflict = await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: 'folder-d', drive: 'main', name: 'report.txt', kind: 'file' },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    )
    const h = await harness()
    h.bridge.createFileFromPath.mockImplementation(async () => {
      revoke(h)
      throw new Error(conflict)
    })
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    await act(async () => pick(file()))

    await waitFor(() => expect(overlayOpen(h)).toBe(false))
    expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
    click.mockRestore()
  })

  it('a cancelled picker closes the action', async () => {
    const h = await harness()
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    act(() => {
      screen.getByTestId('gfs-action-host-upload-input').dispatchEvent(new Event('cancel'))
    })

    expect(overlayOpen(h)).toBe(false)
    expect(mutationCalls(h)).toBe(0)
    click.mockRestore()
  })
})

describe('GfsActionHost — move', () => {
  it('S-10: with the move running, Escape, the backdrop and Cancel are ignored and the moving id stays until it settles', async () => {
    const h = await harness()
    const target: GfsHostActionTarget = {
      ...(await listedRow('file-t', 'notes.txt', 'file', 'folder-p')),
      ancestorCrumbs: [
        {
          resourceId: 'folder-q',
          gfsUri: 'gfs://main/folder-q',
          name: 'Archive',
          kind: 'directory',
          version: 1,
          bytes: 0,
        },
      ],
    }
    h.bridge.resolve.mockImplementation(async () =>
      resolveResource(
        resolvedFile('file-t', 'notes.txt', { parentResourceId: 'folder-p', version: 3 })
      )
    )
    const landed = deferred<Awaited<ReturnType<typeof moveResourceReceipt>>>()
    h.bridge.moveResource.mockImplementation(() => landed.promise)

    h.open(target, 'move')
    const moveDialog = await screen.findByRole('dialog', { name: /move/i })
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(h.bridge.moveResource).toHaveBeenCalledTimes(1))
    expect(h.host().hostMovingResourceId).toBe('file-t')

    fireEvent.keyDown(window, { key: 'Escape' })
    const backdrop = moveDialog.parentElement as HTMLElement
    fireEvent.mouseDown(backdrop, { target: backdrop })
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Cancel' }))
    await act(async () => {})
    expect(dialog()).toBeTruthy()
    expect(h.host().hostMovingResourceId).toBe('file-t')
    expect(overlayOpen(h)).toBe(true)

    await act(async () => landed.resolve(await moveResourceReceipt('file-t', 'folder-q', 4)))

    await waitFor(() => expect(dialog()).toBeNull())
    expect(h.host().hostMovingResourceId).toBeNull()
    expect(toastMessages(h)).toContain('Moved notes.txt to Archive')
    // The receipt converges the caches; the Files location still needs its own re-read.
    expect(h.refreshFilesLocation).toHaveBeenCalledTimes(1)
  })
})

describe('GfsActionHost — share', () => {
  async function shareTarget() {
    return listedRow('folder-s', 'Shared', 'directory', null)
  }
  const resolveShared = () =>
    resolveResource(resolvedDirectory('folder-s', 'Shared', { parentResourceId: null }))

  it('S-15: a 429 on listGrants shows an error with Retry, never an empty access list', async () => {
    const limited = await listGrantsFailureMessage(429, {
      code: 'rate_limited',
      message: 'too many requests',
    })
    const h = await harness()
    h.bridge.resolve.mockImplementation(resolveShared)
    h.bridge.listGrants.mockRejectedValue(new Error(limited))

    h.open(await shareTarget(), 'share')
    const share = await screen.findByRole('dialog', { name: /shared/i })

    await waitFor(() => expect(within(share).getByRole('button', { name: 'Retry' })).toBeTruthy())
    expect(within(share).queryByText('No one has access yet.')).toBeNull()
    expect(h.bridge.listAccessible).not.toHaveBeenCalled()
    expect(
      h.client
        .getQueryCache()
        .findAll({ queryKey: desktopQueryKeys.gfsAccessible(SCOPE, 'main', 1) })
    ).toEqual([])
  })

  it('S-19: an accessChanged from the watch re-reads the open dialog ACLs', async () => {
    const source = await new GfsWatchEventSource().start()
    try {
      const watch = source.connectRenderer()
      const h = await harness({ gfsWatch: watch.bridge })
      h.bridge.resolve.mockImplementation(resolveShared)
      await waitFor(() => expect(watch.opens).toBe(1))

      h.open(await shareTarget(), 'share')
      await screen.findByRole('dialog', { name: /shared/i })
      await waitFor(() => expect(h.bridge.listGrants).toHaveBeenCalled())
      const grantsBefore = h.bridge.listGrants.mock.calls.length
      const sharesBefore = h.bridge.listShares.mock.calls.length

      await act(async () => {
        await source.reauthorize([mainDriveKey('dir', 'folder-s')])
      })

      await waitFor(() =>
        expect(h.bridge.listGrants.mock.calls.length).toBeGreaterThan(grantsBefore)
      )
      expect(h.bridge.listShares.mock.calls.length).toBeGreaterThan(sharesBefore)
    } finally {
      await source.stop()
    }
  })
})

describe('GfsActionHost — review round', () => {
  const file = (name = 'report.txt') => new File(['data'], name, { type: 'text/plain' })
  const pick = (selected: File) =>
    fireEvent.change(screen.getByTestId('gfs-action-host-upload-input'), {
      target: { files: [selected] },
    })
  const archive = {
    resourceId: 'folder-q',
    gfsUri: 'gfs://main/folder-q',
    name: 'Archive',
    kind: 'directory' as const,
    version: 1,
    bytes: 0,
  }
  async function moveTarget(): Promise<GfsHostActionTarget> {
    return {
      ...(await listedRow('file-t', 'notes.txt', 'file', 'folder-p')),
      ancestorCrumbs: [archive],
    }
  }
  const resolvedSource = () =>
    resolveResource(
      resolvedFile('file-t', 'notes.txt', { parentResourceId: 'folder-p', version: 3 })
    )

  it('B1: a revocation seen while the move runs closes the action once it stops running', async () => {
    const h = await harness()
    h.bridge.resolve.mockImplementation(async () => resolvedSource())
    const landed = deferred<Awaited<ReturnType<typeof moveResourceReceipt>>>()
    h.bridge.moveResource.mockImplementation(() => landed.promise)

    h.open(await moveTarget(), 'move')
    const moveDialog = await screen.findByRole('dialog', { name: /move/i })
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move here (Archive)' }))
    await waitFor(() => expect(h.bridge.moveResource).toHaveBeenCalledTimes(1))
    // The revocation renders while the move runs, so the revocation effect skips it.
    await act(async () => {
      revoke(h)
      await new Promise(done => window.setTimeout(done, 0))
    })
    expect(dialog()).toBeTruthy()

    await act(async () => landed.resolve(await moveResourceReceipt('file-t', 'folder-q', 4)))
    await act(async () => {
      await new Promise(done => window.setTimeout(done, 20))
    })

    expect(dialog()).toBeNull()
    expect(overlayOpen(h)).toBe(false)
    expect(h.host().hostMovingResourceId).toBeNull()
  })

  it('S5: a source that changed since it was chosen stops the move with a visible error', async () => {
    const h = await harness()
    // The row carried version 3; the server now holds version 4.
    h.bridge.resolve.mockImplementation(async () =>
      resolveResource(
        resolvedFile('file-t', 'notes.txt', { parentResourceId: 'folder-p', version: 4 })
      )
    )
    h.bridge.moveResource.mockImplementation(async () =>
      moveResourceReceipt('file-t', 'folder-q', 5)
    )

    h.open(await moveTarget(), 'move')
    const moveDialog = await screen.findByRole('dialog', { name: /move/i })
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move here (Archive)' }))

    await waitFor(() =>
      expect(within(moveDialog).getByText(/changed while you were moving it/)).toBeTruthy()
    )
    expect(h.bridge.moveResource).not.toHaveBeenCalled()
    expect(dialog()).toBe(moveDialog)
    expect(h.host().hostMovingResourceId).toBeNull()
  })

  it('S1: a revocation in the same tick as "Move here" sends no move', async () => {
    const h = await harness()
    h.bridge.resolve.mockImplementation(async () => resolvedSource())
    h.bridge.moveResource.mockImplementation(async () =>
      moveResourceReceipt('file-t', 'folder-q', 4)
    )

    h.open(await moveTarget(), 'move')
    const moveDialog = await screen.findByRole('dialog', { name: /move/i })
    const moveHere = within(moveDialog).getByRole('button', { name: 'Move here (Archive)' })
    h.bridge.resolve.mockImplementation(async () => {
      revoke(h)
      return resolvedSource()
    })
    act(() => moveHere.click())
    await waitFor(() => expect(h.bridge.resolve).toHaveBeenCalled())
    await act(async () => {
      await new Promise(done => window.setTimeout(done, 20))
    })

    expect(h.bridge.moveResource).not.toHaveBeenCalled()
  })

  it('S2: a second upload starts while the first is still in flight', async () => {
    const h = await harness()
    const first = deferred<Awaited<ReturnType<typeof createFolderResult>>>()
    h.bridge.createFileFromPath.mockImplementationOnce(() => first.promise)
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    await act(async () => pick(file('one.txt')))
    await waitFor(() => expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1))
    expect(overlayOpen(h)).toBe(false)

    h.open(folder, 'upload-file')
    expect(overlayOpen(h)).toBe(true)
    await act(async () => pick(file('two.txt')))

    await waitFor(() => expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(2))
    expect(h.bridge.createFileFromPath.mock.calls.map(call => call[1])).toEqual([
      'one.txt',
      'two.txt',
    ])
    await act(async () =>
      first.resolve(await createFolderResult('folder-d', childView('u1', 'one.txt', 'file')))
    )
    await waitFor(() =>
      expect(toastMessages(h).sort()).toEqual(['Uploaded one.txt', 'Uploaded two.txt'])
    )
    click.mockRestore()
  })

  it('S2: an upload that lands after a session switch shows no toast', async () => {
    const h = await harness()
    const landed = deferred<Awaited<ReturnType<typeof createFolderResult>>>()
    h.bridge.createFileFromPath.mockImplementationOnce(() => landed.promise)
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    await act(async () => pick(file()))
    await waitFor(() => expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1))
    h.main.generation = 2
    await act(async () =>
      landed.resolve(await createFolderResult('folder-d', childView('u1', 'report.txt', 'file')))
    )
    await act(async () => {})

    expect(h.toasts).toEqual([])
    click.mockRestore()
  })

  it('S2: a revocation ends an upload in flight even if access is restored before its retry', async () => {
    const conflict = await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: 'folder-d', drive: 'main', name: 'report.txt', kind: 'file' },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    )
    const h = await harness()
    const firstAttempt = deferred<never>()
    h.bridge.createFileFromPath.mockImplementationOnce(() => firstAttempt.promise)
    const folder = await listedRow('folder-d', 'Docs', 'directory')
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    h.open(folder, 'upload-file')
    await act(async () => pick(file()))
    await waitFor(() => expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1))
    // Revoke, then retry access in the same session: the flag reads active again.
    await act(async () => {
      revoke(h)
      await new Promise(done => window.setTimeout(done, 0))
    })
    await act(async () => {
      h.client.setQueryData(desktopQueryKeys.gfsAccessState(SCOPE, 1), 'active')
      await new Promise(done => window.setTimeout(done, 0))
    })
    await act(async () => firstAttempt.reject(new Error(conflict)))
    await act(async () => {})

    expect(h.bridge.createFileFromPath).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
    click.mockRestore()
  })

  it('L3: a download that lands after a session switch shows no toast', async () => {
    const h = await harness()
    const createObjectURL = vi.fn(() => 'blob:fixture')
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const saved = deferred<Awaited<ReturnType<typeof downloadResult>>>()
    h.bridge.download.mockImplementation(() => saved.promise)
    const target = await listedRow('file-t', 'notes.txt', 'file')

    h.open(target, 'download')
    await waitFor(() => expect(h.bridge.download).toHaveBeenCalledTimes(1))
    h.main.generation = 2
    await act(async () => saved.resolve(await downloadResult(resolvedFile('file-t', 'notes.txt'))))
    await act(async () => {})

    expect(anchorClick).toHaveBeenCalledTimes(1)
    expect(h.toasts).toEqual([])
    anchorClick.mockRestore()
  })

  it('L3 (control): a download in the same session toasts', async () => {
    const h = await harness()
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() })
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    h.bridge.download.mockImplementation(async () =>
      downloadResult(resolvedFile('file-t', 'notes.txt'))
    )

    h.open(await listedRow('file-t', 'notes.txt', 'file'), 'download')

    await waitFor(() => expect(toastMessages(h)).toEqual(['Downloaded notes.txt']))
    anchorClick.mockRestore()
  })

  describe('S-9: granting from the host Share', () => {
    const agent = {
      name: 'chatllm',
      contextRef: 'ctx-1',
      mcpServers: [],
      gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
    }
    async function openShareAndPick(h: Harness) {
      h.bridge.resolve.mockImplementation(async () =>
        resolveResource(resolvedDirectory('folder-s', 'Shared', { parentResourceId: null }))
      )
      h.open(await listedRow('folder-s', 'Shared', 'directory', null), 'share')
      const share = await screen.findByRole('dialog', { name: /shared/i })
      const input = await within(share).findByRole('combobox', {
        name: 'Add people, teams, or agents',
      })
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: 'chatllm' } })
      fireEvent.click(await within(share).findByRole('option', { name: /chatllm/ }))
      return share
    }

    it('grants to the chosen subject on the chosen target', async () => {
      const h = await harness({ myAgents: [agent] })
      const share = await openShareAndPick(h)

      fireEvent.click(within(share).getByRole('button', { name: 'Share' }))

      await waitFor(() => expect(h.bridge.grant).toHaveBeenCalledTimes(1))
      expect(h.bridge.grant.mock.calls[0]![0]).toBe('folder-s')
    })

    it('sends no grant when main runs another session at submit', async () => {
      const h = await harness({ myAgents: [agent] })
      const share = await openShareAndPick(h)
      h.main.generation = 2

      fireEvent.click(within(share).getByRole('button', { name: 'Share' }))
      await waitFor(() => expect(h.bridge.getSessionGeneration).toHaveBeenCalled())
      await act(async () => {
        await new Promise(done => window.setTimeout(done, 20))
      })

      expect(h.bridge.grant).not.toHaveBeenCalled()
    })
  })

  describe('removing access from the host Share', () => {
    const grantId = '42424242-4242-4242-4242-424242424242'
    const agent = {
      name: 'chatllm',
      contextRef: 'ctx-1',
      mcpServers: [],
      gfsSubject: { type: 'host' as const, id: '1st:mcp-host/chatllm' },
    }

    /** Opens Share on a folder whose access list holds one agent grant and removes it. */
    async function removeAgentAccess(h: Harness) {
      const agentGrant = await grantsListPage([
        {
          id: grantId,
          drive: 'main',
          resourceId: 'folder-s',
          subject: { type: 'host', id: '1st:mcp-host/chatllm' },
          permissions: ['read'],
          inherit: true,
        },
      ])
      h.bridge.listGrants.mockImplementation(async () => agentGrant)
      h.bridge.resolve.mockImplementation(async () =>
        resolveResource(resolvedDirectory('folder-s', 'Shared', { parentResourceId: null }))
      )
      const revoked = deferred<undefined>()
      h.bridge.revokeGrant.mockImplementation(() => revoked.promise)
      h.open(await listedRow('folder-s', 'Shared', 'directory', null), 'share')
      const share = await screen.findByRole('dialog', { name: /shared/i })
      fireEvent.click(await within(share).findByRole('button', { name: 'Actions for chatllm' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Remove access' }))
      await waitFor(() => expect(h.bridge.revokeGrant).toHaveBeenCalledWith(grantId))
      return revoked
    }

    it('a removal that lands after a session switch shows no toast in the new session', async () => {
      const h = await harness({ myAgents: [agent] })
      const revoked = await removeAgentAccess(h)

      h.main.generation = 2
      h.publish(2)
      await waitFor(() => expect(dialog()).toBeNull())
      await act(async () => revoked.resolve(undefined))
      await act(async () => {})

      expect(h.toasts).toEqual([])
    })

    it('(control) the same removal in the same session toasts it', async () => {
      const h = await harness({ myAgents: [agent] })
      const revoked = await removeAgentAccess(h)

      await act(async () => revoked.resolve(undefined))

      await waitFor(() => expect(toastMessages(h)).toEqual(['Access revoked for chatllm']))
    })
  })
})
