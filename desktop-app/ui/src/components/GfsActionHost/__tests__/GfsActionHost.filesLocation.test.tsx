// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useGfsWatchSubscription } from '@hooks/domain/useGfsWatchSubscription'
import { useGfsWatchKeyReactions } from '@hooks/useGfsWatchKeyReactions'
import { gfsWatchKey } from '@lib/gfsWatchKeys'
import { desktopQueryDefaults } from '@lib/queryClient'
import { FilesPage } from '@pages/FilesPage'
import {
  accessibleResource,
  childView,
  listAccessiblePage,
  listChildrenPage,
  moveResourceReceipt,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import { GfsActionHost } from '..'
import { delegationAffordances } from '../../../../../src/gfs/delegation.js'
import { useGfsActionHost } from '../context'
import type { GfsActionHostContextValue, GfsHostActionTarget } from '../types'

const me = {
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId: 'team-a',
  teamName: 'Team A',
  role: 'member',
}
const auth = {
  isAuthenticated: true,
  me,
  runtimeConfigState: null,
  sessionGeneration: 1,
} as unknown as AuthContextValue

// The open Files location Q lives in folder A; T is another file of A, and C a file of Q.
const A = 'aaaa0000aaaa0000aaaa0000aaaa0000'
const Q = 'bbbb0000bbbb0000bbbb0000bbbb0000'
const T = 'cccc0000cccc0000cccc0000cccc0000'
const C = 'dddd0000dddd0000dddd0000dddd0000'
// Another root folder, a destination for moves.
const Z = 'eeee0000eeee0000eeee0000eeee0000'
const Q_URI = `gfs://main/${Q}`
const Q_KEY = mainDriveKey('dir', Q)

interface World {
  names: Record<string, string>
  /** Where Q lives; a host Move changes it. */
  parentOfQ?: string
  resolveCalls: string[]
  /** Highest number of location resolves of Q in flight at once. */
  maxConcurrentQ: number
  onResolveQ?: () => void
}

async function installBridge(world: World) {
  let inFlightQ = 0
  const resolve = vi.fn(async (uri: string) => {
    world.resolveCalls.push(uri)
    const id = uri.replace('gfs://main/', '')
    if (id === Q) {
      inFlightQ += 1
      world.maxConcurrentQ = Math.max(world.maxConcurrentQ, inFlightQ)
      world.onResolveQ?.()
      await new Promise(done => window.setTimeout(done, 15))
      inFlightQ -= 1
      return resolveResource(
        resolvedDirectory(Q, world.names[Q]!, {
          parentResourceId: world.parentOfQ ?? A,
          gfsUri: Q_URI,
          version: world.parentOfQ && world.parentOfQ !== A ? 4 : 3,
        })
      )
    }
    if (id === A) {
      return resolveResource(resolvedDirectory(A, world.names[A]!, { parentResourceId: null }))
    }
    if (id === Z && world.names[Z]) {
      return resolveResource(resolvedDirectory(Z, world.names[Z], { parentResourceId: null }))
    }
    if (id === T) {
      return resolveResource(resolvedFile(T, world.names[T]!, { parentResourceId: A, version: 3 }))
    }
    if (id === C) {
      return resolveResource(resolvedFile(C, world.names[C]!, { parentResourceId: Q, version: 3 }))
    }
    throw new Error(`unexpected resolve ${uri}`)
  })
  const renameResource = vi.fn(async (resourceId: string, name: string) => {
    world.names[resourceId] = name
    return renameResourceResult(resourceId, name, 4)
  })
  const moveResource = vi.fn(async (resourceId: string, destinationId: string) => {
    if (resourceId === Q) world.parentOfQ = destinationId
    return moveResourceReceipt(resourceId, destinationId, 4)
  })
  const listChildren = vi.fn(async (parentId: string) =>
    listChildrenPage(
      parentId === Q
        ? [childView(C, world.names[C]!, 'file', { parentResourceId: Q, version: 3 })]
        : []
    )
  )
  const bridge = {
    resolve,
    renameResource,
    moveResource,
    listChildren,
    listAccessible: vi.fn(async () =>
      listAccessiblePage(
        world.names[Z]
          ? [
              accessibleResource(A, world.names[A]!, 'directory', {
                permissions: ['read', 'write'],
              }),
              accessibleResource(Z, world.names[Z], 'directory', {
                permissions: ['read', 'write'],
              }),
            ]
          : []
      )
    ),
    affordances: vi.fn(async () =>
      delegationAffordances(new Set(['read', 'write', 'delete', 'manage_acl']), false)
    ),
    listGrants: vi.fn(async () => ({ items: [] })),
    listShares: vi.fn(async () => ({ items: [] })),
  }
  return bridge
}

let hostValue: GfsActionHostContextValue | null = null
let setTreeMounted: (mounted: boolean) => void = () => {}

function Probe() {
  hostValue = useGfsActionHost()
  return null
}

/** App's Files seam: the watch reactions, the active location key and one keyed FilesPage. */
function FilesShell({ locations }: { locations: Array<string | null> }) {
  const queryClient = useQueryClient()
  const authorityRef = useRef({ scope: ':user-a:team-a', generation: 1 })
  const [resolved, setResolved] = useState<{ gfsUri: string; kind: 'file' | 'directory' } | null>(
    null
  )
  const activeFilesLocationKeyRef = useRef<string | null>(null)
  activeFilesLocationKeyRef.current = resolved
    ? gfsWatchKey(resolved.kind === 'file' ? 'file' : 'dir', resolved.gfsUri)
    : null
  const reactions = useGfsWatchKeyReactions({
    queryClient,
    authorityRef,
    activeFilesLocationKeyRef,
    refreshFilePreviews: async () => {},
  })
  useGfsWatchSubscription({
    keys: [],
    userId: null,
    sessionKey: 'session',
    onEvent: event => {
      if (event.type === 'changed') for (const key of event.keys) reactions.reactToGfsWatchKey(key)
    },
  })
  const [treeMounted, setMounted] = useState(true)
  setTreeMounted = setMounted
  return (
    <GfsActionHost
      pushToast={() => {}}
      refreshFilesLocation={reactions.refreshFilesLocation}
      onActionOpenChange={() => {}}
    >
      <Probe />
      {treeMounted ? <nav data-testid="tree-stand-in" /> : null}
      <FilesPage
        workspaceTabId="files-1"
        pendingGfsUri={Q_URI}
        onLocationChange={uri => locations.push(uri)}
        onResolvedLocationChange={setResolved}
        registerLocationRefresh={reactions.registerFilesLocationRefresh}
      />
    </GfsActionHost>
  )
}

async function mount(world: World, gfsWatch?: Window['clerum']['gfsWatch']) {
  const bridge = await installBridge(world)
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: { getSessionGeneration: vi.fn(async () => 1) },
      gfs: { ...bridge, getPathForFile: () => null },
      team: { directory: vi.fn(async () => ({ items: [] })) },
      agents: { listMine: vi.fn(async () => []) },
      ...(gfsWatch ? { gfsWatch } : {}),
    },
  })
  const client = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const locations: Array<string | null> = []
  render(
    <AuthContext.Provider value={auth}>
      <QueryClientProvider client={client}>
        <FilesShell locations={locations} />
      </QueryClientProvider>
    </AuthContext.Provider>
  )
  await waitFor(() => expect(crumbs()).toEqual([world.names[A], world.names[Q]]))
  await act(async () => {
    await new Promise(done => window.setTimeout(done, 30))
  })
  return { bridge, locations }
}

function crumbs(): string[] {
  return Array.from(document.querySelectorAll('.da-gfs-drive__crumb-group')).map(
    node => node.textContent ?? ''
  )
}

async function target(
  resourceId: string,
  name: string,
  kind: 'file' | 'directory',
  parentResourceId: string | null
): Promise<GfsHostActionTarget> {
  const page = await listChildrenPage([
    childView(resourceId, name, kind, { parentResourceId, version: 3 }),
  ])
  return page.items[0] as GfsHostActionTarget
}

async function rename(item: GfsHostActionTarget, name: string) {
  act(() => hostValue!.openGfsAction(item, 'rename'))
  const label = item.kind === 'directory' ? /rename folder/i : /rename file/i
  await screen.findByRole('dialog', { name: label })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
}

const settle = () =>
  act(async () => {
    await new Promise(done => window.setTimeout(done, 80))
  })

afterEach(() => {
  cleanup()
  hostValue = null
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
})

describe('GfsActionHost — the Files location on screen', () => {
  const world = (): World => ({
    names: { [A]: 'Alpha', [Q]: 'Quarterly', [T]: 'notes.txt', [C]: 'chart.png' },
    resolveCalls: [],
    maxConcurrentQ: 0,
  })

  it('S-8: an action on a resource outside Q keeps the Files location and its crumbs', async () => {
    const w = world()
    const { locations } = await mount(w)
    const before = [...locations]

    await rename(await target(T, 'notes.txt', 'file', A), 'renamed.txt')
    await settle()

    expect(crumbs()).toEqual(['Alpha', 'Quarterly'])
    expect(locations.filter(uri => uri !== Q_URI)).toEqual(before.filter(uri => uri !== Q_URI))
    expect(locations[locations.length - 1]).toBe(Q_URI)
  })

  it('S-8 (L2): renaming an ancestor of Q shows the new crumbs at rest', async () => {
    const w = world()
    const { locations } = await mount(w)

    await rename(await target(A, 'Alpha', 'directory', null), 'Alpha 2')

    await waitFor(() => expect(crumbs()).toEqual(['Alpha 2', 'Quarterly']))
    expect(locations[locations.length - 1]).toBe(Q_URI)
  })

  it('L2: moving Q into another folder shows its new crumbs at rest', async () => {
    const w = { ...world(), names: { ...world().names, [Z]: 'Zeta' } }
    const { bridge, locations } = await mount(w)
    const quarterly: GfsHostActionTarget = {
      ...(await target(Q, 'Quarterly', 'directory', A)),
      version: 3,
      ancestorCrumbs: [],
    }

    act(() => hostValue!.openGfsAction(quarterly, 'move'))
    const moveDialog = await screen.findByRole('dialog', { name: /move folder quarterly/i })
    fireEvent.click(await within(moveDialog).findByRole('button', { name: 'Zeta' }))
    fireEvent.click(within(moveDialog).getByRole('button', { name: 'Move here (Zeta)' }))
    await waitFor(() => expect(bridge.moveResource).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await waitFor(() => expect(crumbs()).toEqual(['Zeta', 'Quarterly']))
    expect(locations[locations.length - 1]).toBe(Q_URI)
    // The host's refresh and the move's own convergence never re-read Q at once (K1).
    await settle()
    expect(w.maxConcurrentQ).toBe(1)
  })

  it('S-8: the dialog outlives the tree that opened it', async () => {
    const w = world()
    await mount(w)
    const item = await target(T, 'notes.txt', 'file', A)
    act(() => hostValue!.openGfsAction(item, 'rename'))
    await screen.findByRole('dialog', { name: /rename file/i })

    act(() => setTreeMounted(false))

    expect(screen.queryByTestId('tree-stand-in')).toBeNull()
    expect(screen.getByRole('dialog', { name: /rename file/i })).toBeTruthy()
  })

  it('K1: a host change inside Q and the watch echo re-read Q at most twice, never at once', async () => {
    const source = await new GfsWatchEventSource().start([Q_KEY])
    try {
      const watch = source.connectRenderer()
      const echo = await source.changed([Q_KEY])
      const w = world()
      await mount(w, watch.bridge)
      await waitFor(() => expect(watch.opens).toBe(1))
      const resolvesBefore = w.resolveCalls.filter(uri => uri === Q_URI).length
      let echoed = false
      w.onResolveQ = () => {
        if (echoed) return
        echoed = true
        // The echo of the host's own write lands while its refresh of Q is in flight.
        watch.deliver(echo)
      }

      await rename(await target(C, 'chart.png', 'file', Q), 'graph.png')
      await settle()

      const resolvesOfQ = w.resolveCalls.filter(uri => uri === Q_URI).length - resolvesBefore
      expect(echoed).toBe(true)
      expect(resolvesOfQ).toBeGreaterThanOrEqual(1)
      expect(resolvesOfQ).toBeLessThanOrEqual(2)
      expect(w.maxConcurrentQ).toBe(1)
      expect(crumbs()).toEqual(['Alpha', 'Quarterly'])
    } finally {
      await source.stop()
    }
  })
})
