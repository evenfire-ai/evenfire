// @vitest-environment jsdom
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { GFS_UPLOAD_NAME_RETRY_LIMIT } from '@clerum/gfs-interaction-policy'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { useGfsWatchSubscription } from '@hooks/domain/useGfsWatchSubscription'
import { useGfsWatchKeyReactions } from '@hooks/useGfsWatchKeyReactions'
import { revokeGfsSessionAccess } from '@lib/gfsSessionAuthority'
import { buildGfsWatchKeys, gfsWatchKey } from '@lib/gfsWatchKeys'
import { purgeGfsSessionCache, refetchGfsAccess } from '@lib/gfsWatchReaction'
import { desktopQueryDefaults } from '@lib/queryClient'
import { FilesPage } from '@pages/FilesPage'
import {
  LaunchingSandboxUiPage,
  createPageEmbed,
} from '@pages/__tests__/__fixtures__/launchingSandboxUiPage'
import {
  accessibleResource,
  childView,
  createFolderResult,
  gfsRouteFailureMessage,
  grantsListPage,
  listAccessiblePage,
  listChildrenPage,
  moveResourceReceipt,
  renameResourceResult,
  resolveResource,
  resolvedDirectory,
  resolvedFile,
  sharesListPage,
} from '@/gfs/__fixtures__/gfsProducerFixtures'
import { GfsWatchEventSource, mainDriveKey } from '@/gfs/__fixtures__/gfsWatchEvents'
import {
  appServiceAffordanceProducer,
  heldPermissionResponse,
} from '@/gfs/__fixtures__/permissionProducerFixtures'
import { GfsDragSessionProvider } from '@/gfs/dragSession'
import { GfsActionHost } from '..'
import { AppService } from '../../../../../src/appService.js'
import { GfsClient } from '../../../../../src/gfs/uriHandler.js'
import type { GfsWatchEvent } from '../../../../../src/types.js'
import { useGfsActionOverlay } from '../overlay'

/*
 * Model-based oracle for the sidebar's resource actions. It drives the real
 * composition the actions live in (tree with its row menu, the window-level
 * action host, a Files location consumer and the native app view gate) with
 * generated sequences of user and session events, while `fc.scheduler()`
 * decides when every IPC answer lands. At rest it compares what the user
 * would see against a deliberately small reference model of who may act on
 * what, under which session.
 *
 * Only `window.clerum.*` is fake. Every wire value is minted by main's own
 * producers (GfsClient, AppService) or captured from main's real watch client.
 */

// ── The fake server ─────────────────────────────────────────────────────────

const DOCS = 'a1'.repeat(16)
const ARCHIVE = 'e5'.repeat(16)
const NOTES = 'c3'.repeat(16)
const QUARTER = 'b2'.repeat(16)
const README = 'd4'.repeat(16)
const CHART = 'f6'.repeat(16)
const ALL_BITS = ['read', 'write', 'delete', 'manage_acl']
const WATCHED_DIRS = [DOCS, QUARTER, ARCHIVE]
const uriOf = (id: string) => `gfs://main/${id}`
const QUARTER_URI = uriOf(QUARTER)

interface ServerNode {
  id: string
  name: string
  kind: 'file' | 'directory'
  parent: string | null
  version: number
  held: string[]
}

function seedServer(): Map<string, ServerNode> {
  const nodes: ServerNode[] = [
    { id: DOCS, name: 'Docs', kind: 'directory', parent: null, version: 1, held: ALL_BITS },
    { id: ARCHIVE, name: 'Archive', kind: 'directory', parent: null, version: 1, held: ALL_BITS },
    { id: NOTES, name: 'notes.txt', kind: 'file', parent: DOCS, version: 3, held: ALL_BITS },
    { id: QUARTER, name: 'Quarterly', kind: 'directory', parent: DOCS, version: 2, held: ALL_BITS },
    // Read-only: its menu must never offer what its own bits refuse.
    { id: README, name: 'readme.md', kind: 'file', parent: DOCS, version: 1, held: ['read'] },
    { id: CHART, name: 'chart.png', kind: 'file', parent: QUARTER, version: 1, held: ALL_BITS },
  ]
  return new Map(nodes.map(node => [node.id, { ...node }]))
}

function pathOf(nodes: Map<string, ServerNode>, id: string): string[] | null {
  const names: string[] = []
  for (let at: string | null = id; at; ) {
    const node = nodes.get(at)
    if (!node) return null
    names.unshift(node.name)
    at = node.parent
  }
  return names
}

// Producer-derived failures, minted once.
interface Failures {
  stale: string
  conflict: string
  notFound: string
}
let failures: Failures

async function deleteReceipt(resourceId: string, ifMatch: number) {
  const client = new GfsClient({
    baseUrl: 'https://gfs.fixture.test',
    requestJson: async () => ({ ok: true, data: { deleted: true, resourceId } }) as never,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  return structuredClone(
    await client.deleteResource({ resourceId, drive: 'main', ifMatch }, 'fixture-session-token')
  )
}

/** Main's own generation fence for a move, as AppService throws it. */
function assertMainGeneration(mainGeneration: number, expected: number | undefined) {
  if (expected === undefined) return
  const service = Object.create(AppService.prototype) as AppService
  Object.assign(service, { sessionGeneration: mainGeneration })
  ;(
    service as unknown as { assertSessionGeneration(expected: number): void }
  ).assertSessionGeneration(expected)
}

// ── Captured watch events ───────────────────────────────────────────────────

let watchSource: GfsWatchEventSource
const changedEvents = new Map<string, GfsWatchEvent[]>()
let sessionExpiredEvents: GfsWatchEvent[] = []

// ── The run's world: fakes, logs and the reference model ────────────────────

type Team = 'team-a' | 'team-b'
interface Session {
  team: Team
  gen: number
}
const scopeOf = (team: Team) => `:user-a:${team}`
const sessionKey = (session: { team: Team; gen: number }) => `${session.team}#${session.gen}`

type MutationOp =
  | 'renameResource'
  | 'deleteResource'
  | 'createFolder'
  | 'createFileFromPath'
  | 'moveResource'

interface MutationCall {
  op: MutationOp
  target: string
  ifMatch?: number
  at: number
  settled: boolean
  submission: Submission | null
}

interface Submission {
  id: number
  op: MutationOp
  target: string
  /** Versions the cache held for the row when its menu opened. */
  versions: number[]
  origin: Session
  /** Revocations of the origin after this point forbid every create (uploads). */
  openedAt: number
  at: number
  calls: MutationCall[]
  actionToken: number
  /** When the user closed the dialog this submit came from, if they did. */
  dismissedAt: number | null
}

interface ModelAction {
  token: number
  actionId: string
  target: string
  targetName: string
  versions: number[]
  origin: Session
  at: number
  dismissedAt: number | null
  submitted: boolean
}

interface Model {
  session: Session
  mainGen: number
  pendingPublish: boolean
  menu: {
    token: number
    target: string
    name: string
    versions: number[]
    origin: Session
    openedAt: number
  } | null
  action: ModelAction | null
  pickerOpen: boolean
  filesTab: { active: boolean; mountedAt: number; route: string | null }
  treeMounted: boolean
  nextToken: number
}

interface Toast {
  at: number
  message: string
  tone: string
  session: Session
}

interface GenCall {
  at: number
  answer: number
  host: boolean
}

interface AccessEvent {
  at: number
  session: string
  kind: 'revoke' | 'expired' | 'retry'
}

interface World {
  s: Scheduler
  clock: number
  nodes: Map<string, ServerNode>
  nextId: number
  model: Model
  store: {
    get: () => Session
    set: (next: Session) => void
    subscribe: (cb: () => void) => () => void
  }
  ui: {
    get: () => UiState
    set: (next: Partial<UiState>) => void
    subscribe: (cb: () => void) => () => void
  }
  queryClient: QueryClient
  calls: MutationCall[]
  submissions: Submission[]
  toasts: Toast[]
  genCalls: GenCall[]
  mainSwitches: number[]
  publishes: number[]
  access: AccessEvent[]
  locations: Array<string | null>
  visibility: boolean[]
  affordanceCalls: number
  hostListAccessible: number
  pickerClicks: number
  /** A session switch whose renderer publication a fixed example releases. */
  heldPublish: (() => void) | null
  /** Bit reads held until a fixed example releases them. */
  heldBits: Map<string, Promise<void>>
  releaseBits: Map<string, () => void>
  /** Last time every cached bit read went stale. */
  bitsAgedAt: number
  openings: Array<{ origin: Session; at: number }>
  violations: string[]
  watch: ReturnType<GfsWatchEventSource['connectRenderer']>
  embed: ReturnType<typeof createPageEmbed>
}

interface UiState {
  filesActive: boolean
  filesMount: number
  treeMounted: boolean
}

function storeOf<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next: T) => {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
  }
}

const tick = (w: World) => ++w.clock

const fromHost = (stack: string | undefined) =>
  Boolean(stack && /GfsActionHost\/index|resourceActionRunners|explicitMoveDialog/.test(stack))

const HOST_CODE =
  /GfsActionHost\/index|resourceActionRunners|explicitMoveDialog|moveCommit|useGfsResourceOperations/

/**
 * Whether the host's own code asked main for the generation: the nearest app
 * frame decides, skipping the shared session helper. A Files refresh the host
 * merely triggered also has host frames further down, but asks for itself.
 */
const askedByHost = (stack: string | undefined) => {
  const frames = (stack ?? '')
    .split('\n')
    .filter(line => line.includes('/ui/src/') && !line.includes('__tests__'))
    .filter(line => !line.includes('lib/gfsSessionAuthority'))
  return Boolean(frames[0] && HOST_CODE.test(frames[0]))
}

/** Every IPC answer the oracle orders: the scheduler decides when it lands. */
function scheduled<A extends unknown[], R>(
  w: World,
  label: string,
  fn: (...args: A) => Promise<R>
) {
  return (...args: A) => w.s.schedule(fn(...args), label)
}

function accessActive(w: World, session: Session, after = -1): boolean {
  const key = sessionKey(session)
  const events = w.access.filter(event => event.session === key && event.at > after)
  const last = events.at(-1)
  return !last || last.kind === 'retry'
}

function revokedSince(w: World, session: Session, since: number): boolean {
  const key = sessionKey(session)
  return w.access.some(event => event.session === key && event.at > since && event.kind !== 'retry')
}

function sameSession(left: Session, right: Session) {
  return left.team === right.team && left.gen === right.gen
}

/** Whether main still runs `gen`, or a host generation check answered it before main moved on. */
function mainAdmits(w: World, gen: number, since: number): boolean {
  if (w.model.mainGen === gen) return true
  const switchedAt = w.mainSwitches.at(-1) ?? -1
  return w.genCalls.some(
    call => call.host && call.at > since && call.at < switchedAt && call.answer === gen
  )
}

function recordMutation(w: World, op: MutationOp, target: string, ifMatch?: number) {
  const at = tick(w)
  // The latest submit on that resource: an earlier one that never sent has
  // no claim on a later call.
  const submission =
    [...w.submissions]
      .reverse()
      .find(
        s =>
          s.op === op &&
          s.target === target &&
          s.calls.length < (op === 'createFileFromPath' ? GFS_UPLOAD_NAME_RETRY_LIMIT : 1)
      ) ?? null
  const call: MutationCall = { op, target, ifMatch, at, settled: false, submission }
  w.calls.push(call)
  if (!submission) {
    w.violations.push(`S1/S3: ${op}(${target}) started with no submission for that resource`)
    return call
  }
  const live = w.model.session
  const lowerBound = submission.calls.at(-1)?.at ?? submission.at
  if (!sameSession(live, submission.origin)) {
    w.violations.push(`S3: ${op} started after the renderer published another session`)
  }
  if (
    revokedSince(
      w,
      submission.origin,
      op === 'createFileFromPath' ? submission.openedAt : submission.at
    )
  ) {
    w.violations.push(`S3: ${op} started after its session's access was revoked`)
  }
  // Only a move hands its generation to main, which refuses it on its own.
  if (op !== 'moveResource' && !mainAdmits(w, submission.origin.gen, lowerBound)) {
    w.violations.push(`S3: ${op} started after main switched session, with no generation check`)
  }
  if (op === 'renameResource' || op === 'deleteResource' || op === 'moveResource') {
    // The row may still render an older version than the cache holds, never
    // a newer one: a version above what was cached when the menu opened was
    // substituted after the user chose.
    const newestSeen = Math.max(...submission.versions)
    if (ifMatch === undefined || ifMatch > newestSeen) {
      w.violations.push(
        `S5: ${op} sent version ${ifMatch} but the row carried at most ${newestSeen}`
      )
    }
  }
  submission.calls.push(call)
  return call
}

function settleWhenAnswered<T>(call: MutationCall, promise: Promise<T>): Promise<T> {
  return promise.then(
    value => {
      call.settled = true
      return value
    },
    error => {
      call.settled = true
      throw error
    }
  )
}

function installBridge(w: World) {
  const node = (id: string) => w.nodes.get(id)
  const childrenOf = (id: string) => [...w.nodes.values()].filter(n => n.parent === id)
  const nameTaken = (parent: string, name: string) => childrenOf(parent).some(n => n.name === name)
  const affordanceProducer = appServiceAffordanceProducer(async id =>
    heldPermissionResponse(node(id)?.held ?? [])
  )
  const removeSubtree = (id: string) => {
    for (const child of childrenOf(id)) removeSubtree(child.id)
    w.nodes.delete(id)
  }
  const casCheck = (id: string, ifMatch: number | undefined) => {
    const current = node(id)
    if (!current) throw new Error(failures.notFound)
    if (ifMatch !== undefined && ifMatch !== current.version) throw new Error(failures.stale)
    return current
  }
  const mutation =
    <A extends unknown[], R>(
      op: MutationOp,
      targetOf: (...args: A) => { target: string; ifMatch?: number },
      apply: (...args: A) => Promise<R>
    ) =>
    (...args: A) => {
      const { target, ifMatch } = targetOf(...args)
      const call = recordMutation(w, op, target, ifMatch)
      return settleWhenAnswered(call, w.s.schedule(apply(...args), op))
    }
  const gfs = {
    getPathForFile: (file: File) => `/local/${file.name}`,
    listAccessible: vi.fn(async () => {
      if (
        fromHost(new Error().stack) &&
        !/explicitMoveDialog|moveDialog/.test(new Error().stack ?? '')
      ) {
        w.hostListAccessible += 1
      }
      return listAccessiblePage(
        [...w.nodes.values()]
          .filter(n => n.parent === null)
          .map(n =>
            accessibleResource(n.id, n.name, n.kind, { permissions: n.held, version: n.version })
          )
      )
    }),
    listChildren: vi.fn(async (parentId: string) => {
      if (!node(parentId)) throw new Error(failures.notFound)
      return listChildrenPage(
        childrenOf(parentId).map(n =>
          childView(n.id, n.name, n.kind, { parentResourceId: n.parent, version: n.version })
        )
      )
    }),
    resolve: vi.fn(async (uri: string) => {
      const current = node(uri.replace('gfs://main/', ''))
      if (!current) throw new Error(failures.notFound)
      const overrides = { parentResourceId: current.parent, version: current.version }
      return resolveResource(
        current.kind === 'directory'
          ? resolvedDirectory(current.id, current.name, overrides)
          : resolvedFile(current.id, current.name, overrides)
      )
    }),
    affordances: (id: string, drive?: string) => {
      w.affordanceCalls += 1
      // A read the run holds back by hand, outside the scheduler's choice.
      const held = w.heldBits.get(id)
      if (held) return held.then(() => affordanceProducer(id, drive))
      return w.s.schedule(affordanceProducer(id, drive), 'affordances')
    },
    listGrants: vi.fn(async () => grantsListPage([])),
    listShares: vi.fn(async () => sharesListPage([])),
    renameResource: mutation(
      'renameResource',
      (id: string, _name: string, _drive?: string, ifMatch?: number) => ({ target: id, ifMatch }),
      async (id: string, name: string, _drive?: string, ifMatch?: number) => {
        const current = casCheck(id, ifMatch)
        current.name = name
        current.version += 1
        return renameResourceResult(id, name, current.version)
      }
    ),
    deleteResource: mutation(
      'deleteResource',
      (id: string, _drive?: string, ifMatch?: number) => ({ target: id, ifMatch }),
      async (id: string, _drive?: string, ifMatch?: number) => {
        casCheck(id, ifMatch)
        removeSubtree(id)
        return deleteReceipt(id, ifMatch ?? 0)
      }
    ),
    createFolder: mutation(
      'createFolder',
      (parent: string, _name: string) => ({ target: parent }),
      async (parent: string, name: string) => {
        if (!node(parent)) throw new Error(failures.notFound)
        if (nameTaken(parent, name)) throw new Error(failures.conflict)
        const id = newId(w)
        w.nodes.set(id, { id, name, kind: 'directory', parent, version: 1, held: ALL_BITS })
        return createFolderResult(
          parent,
          childView(id, name, 'directory', { parentResourceId: parent })
        )
      }
    ),
    createFileFromPath: mutation(
      'createFileFromPath',
      (parent: string, _name: string) => ({ target: parent }),
      async (parent: string, name: string) => {
        if (!node(parent)) throw new Error(failures.notFound)
        if (nameTaken(parent, name)) throw new Error(failures.conflict)
        const id = newId(w)
        w.nodes.set(id, { id, name, kind: 'file', parent, version: 1, held: ALL_BITS })
        return createFolderResult(parent, childView(id, name, 'file', { parentResourceId: parent }))
      }
    ),
    moveResource: mutation(
      'moveResource',
      (id: string, _destination: string, _drive?: string, ifMatch?: number) => ({
        target: id,
        ifMatch,
      }),
      async (
        id: string,
        destination: string,
        _drive?: string,
        ifMatch?: number,
        newName?: string,
        expectedGeneration?: number
      ) => {
        assertMainGeneration(w.model.mainGen, expectedGeneration)
        const current = casCheck(id, ifMatch)
        if (!node(destination)) throw new Error(failures.notFound)
        if (nameTaken(destination, newName ?? current.name)) throw new Error(failures.conflict)
        current.parent = destination
        if (newName) current.name = newName
        current.version += 1
        return moveResourceReceipt(id, destination, current.version)
      }
    ),
  }
  const sandboxUi = {
    listApps: vi.fn(async () => ({ apps: [] })),
    open: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    copyDeepLink: vi.fn(),
    setBounds: vi.fn(async () => undefined),
    setVisible: scheduled(w, 'setVisible', async (visible: boolean) => {
      w.visibility.push(visible)
    }),
    capturePreview: vi.fn(async () => null),
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(async () => undefined),
    focusActive: vi.fn(async () => true),
    onFindResult: vi.fn(() => vi.fn()),
  }
  Object.defineProperty(window, 'clerum', {
    configurable: true,
    value: {
      auth: {
        getSessionGeneration: (() => {
          const answer = scheduled(w, 'getSessionGeneration', async () => {
            const generation = w.model.mainGen
            w.genCalls.push({
              at: tick(w),
              answer: generation,
              host: askedByHost(stack),
            })
            return generation
          })
          let stack: string | undefined
          return () => {
            stack = new Error().stack
            return answer()
          }
        })(),
      },
      gfs,
      gfsWatch: w.watch.bridge,
      sandboxUi,
      team: { directory: vi.fn(async () => ({ items: [] })) },
      agents: { listMine: vi.fn(async () => []) },
    },
  })
}

function newId(w: World): string {
  w.nextId += 1
  return `${w.nextId.toString(16).padStart(4, '0')}${'9'.repeat(28)}`
}

// ── The composition under test ──────────────────────────────────────────────

const me = (teamId: Team) => ({
  id: 'user-a',
  email: 'a@example.test',
  name: 'User A',
  picture: null,
  teamId,
  teamName: teamId,
  role: 'member',
})
const TASK_APP = { appRef: 'sandbox-recipes/task-board', label: 'Task', defaultPath: '/' }

function Shell({ world }: { world: World }) {
  const session = useSyncExternalStore(world.store.subscribe, world.store.get)
  // The renderer has published a session once a commit renders it: that is
  // when the guards, which read the rendered session, can see it.
  useLayoutEffect(() => {
    const m = world.model
    if (sameSession(m.session, session)) return
    m.session = session
    world.publishes.push(tick(world))
    m.pendingPublish = false
    m.filesTab.mountedAt = world.clock
  }, [session, world])
  const auth = useMemo(
    () =>
      ({
        isAuthenticated: true,
        me: me(session.team),
        runtimeConfigState: null,
        sessionGeneration: session.gen,
      }) as unknown as AuthContextValue,
    [session]
  )
  return (
    <AuthContext.Provider value={auth}>
      <Composition world={world} session={session} />
    </AuthContext.Provider>
  )
}

/** App's seam around the sidebar actions, reduced to the parts they touch. */
function Composition({ world, session }: { world: World; session: Session }) {
  const queryClient = useQueryClient()
  const ui = useSyncExternalStore(world.ui.subscribe, world.ui.get)
  const scope = scopeOf(session.team)
  const authorityRef = useRef({ scope, generation: session.gen })
  authorityRef.current = { scope, generation: session.gen }
  const overlay = useGfsActionOverlay()
  const [watchedFolders, setWatchedFolders] = useState<string[]>([])
  const [resolved, setResolved] = useState<{ gfsUri: string; kind: 'file' | 'directory' } | null>(
    null
  )
  const locationKind = resolved?.kind === 'file' ? 'file' : 'dir'
  const activeFilesLocationKeyRef = useRef<string | null>(null)
  activeFilesLocationKeyRef.current = gfsWatchKey(locationKind, resolved?.gfsUri)
  const keys = useMemo(
    () =>
      buildGfsWatchKeys([
        { kind: locationKind, uri: resolved?.gfsUri },
        ...watchedFolders.map(uri => ({ kind: 'dir' as const, uri })),
      ]),
    [locationKind, resolved?.gfsUri, watchedFolders]
  )
  const reactions = useGfsWatchKeyReactions({
    queryClient,
    authorityRef,
    activeFilesLocationKeyRef,
    refreshFilePreviews: async () => {},
  })
  useGfsWatchSubscription({
    keys,
    userId: 'user-a',
    sessionKey: `${scope}#${session.gen}`,
    onEvent: event => {
      switch (event.type) {
        case 'changed':
        case 'resync':
        case 'rejected':
          for (const key of event.keys) reactions.reactToGfsWatchKey(key)
          return
        case 'accessChanged':
          void refetchGfsAccess(queryClient, authorityRef.current)
          return
        case 'sessionExpired':
          purgeGfsSessionCache(queryClient, authorityRef.current)
          return
      }
    },
  })
  const pushHostToast = (message: string, tone: string) => {
    const toast: Toast = { at: tick(world), message, tone, session: world.model.session }
    judgeToast(world, toast)
    world.toasts.push(toast)
  }
  return (
    <GfsDragSessionProvider>
      <GfsActionHost
        pushToast={pushHostToast}
        refreshFilesLocation={reactions.refreshFilesLocation}
        onActionOpenChange={overlay.onActionOpenChange}
      >
        {ui.treeMounted ? (
          <FileExplorerTree
            onOpenFolder={() => undefined}
            onOpenPreview={() => undefined}
            pushToast={() => undefined}
            onVisibleExpandedFoldersChange={setWatchedFolders}
            onGfsMenuOpenChange={overlay.onGfsMenuOpenChange}
          />
        ) : null}
        {ui.filesActive ? (
          <FilesPage
            // App remounts the Files tab for a new session and on activation.
            key={`${scope}#${session.gen}#${ui.filesMount}`}
            workspaceTabId="files-1"
            pendingGfsUri={world.model.filesTab.route}
            onLocationChange={uri => world.locations.push(uri)}
            onResolvedLocationChange={setResolved}
            registerLocationRefresh={reactions.registerFilesLocationRefresh}
          />
        ) : null}
        <LaunchingSandboxUiPage
          embed={world.embed}
          initialLaunch={TASK_APP}
          sidebarShellOverlayOpen={overlay.overlayOpen}
        />
      </GfsActionHost>
    </GfsDragSessionProvider>
  )
}

// ── Observation helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))

const tree = () => screen.queryByRole('tree', { name: 'Shared files' })
const explorer = () => document.querySelector<HTMLElement>('.da-file-explorer')
const retryButton = () => {
  const root = explorer()
  return root ? within(root).queryByRole('button', { name: 'Retry file access' }) : null
}
const openMenu = () => screen.queryByRole('menu', { name: /^Actions for / })
const hostDialogs = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'))
const crumbs = () =>
  Array.from(document.querySelectorAll('.da-gfs-drive__crumb-group')).map(n => n.textContent ?? '')

function treeRows(_w: World): HTMLElement[] {
  const root = tree()
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>('.da-file-explorer__label'))
}

function rowName(row: HTMLElement) {
  return row.querySelector('.da-file-explorer__name')?.textContent ?? ''
}

function nodeByName(w: World, name: string) {
  return [...w.nodes.values()].find(node => node.name === name)
}

/** Every version the cache holds for a resource, i.e. what its tree row can carry. */
function cachedVersions(w: World, resourceId: string): number[] {
  const versions = new Set<number>()
  for (const [, data] of w.queryClient.getQueriesData({})) {
    const pages = (data as { pages?: Array<{ items?: unknown[] }> } | undefined)?.pages
    const lists = pages ?? [data as { items?: unknown[] } | undefined]
    for (const list of lists) {
      for (const item of list?.items ?? []) {
        const row = item as { resourceId?: string; version?: number }
        if (row.resourceId === resourceId && typeof row.version === 'number')
          versions.add(row.version)
      }
    }
  }
  return [...versions]
}

async function flush() {
  await act(async () => {
    await sleep(0)
  })
}

/** Rest: no IPC answer pending and nothing left for React or the timers to do. */
async function rest(w: World) {
  for (let pass = 0; pass < 2000; pass += 1) {
    // One answer at a time, letting the unscheduled work it starts (listing
    // refetches, React commits) run before the next: draining all at once
    // would always land a pending session publish before slow follow-ups.
    if (w.s.count() > 0) {
      await act(async () => {
        await w.s.waitOne()
        await sleep(2)
      })
      continue
    }
    await act(async () => {
      await sleep(8)
    })
    if (w.s.count() > 0) continue
    await act(async () => {
      await sleep(25)
    })
    if (w.s.count() === 0) return
  }
  throw new Error('the composition never came to rest')
}

/** A host Move whose IPC is in flight: its row must refuse a drag (V6). */
function probeDragDuringMove(w: World) {
  for (const call of w.calls) {
    if (call.op !== 'moveResource' || call.settled) continue
    const name = w.nodes.get(call.target)?.name
    const row = name ? treeRows(w).find(r => rowName(r) === name) : undefined
    if (!row) continue
    const transfer = { types: [] as string[], effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(row, { dataTransfer: transfer })
    if (transfer.setData.mock.calls.length > 0) {
      w.violations.push(`V6: ${name} dragged while the host moves it`)
      fireEvent.dragEnd(row, { dataTransfer: transfer })
    }
  }
}

// ── Invariants at rest ──────────────────────────────────────────────────────

const ACTION_BITS: Record<string, string> = {
  Rename: 'write',
  Delete: 'delete',
  Share: 'manage_acl',
  'New folder': 'write',
  'Upload file': 'write',
}

/**
 * V1/H1, checked after every event: an open menu names its own resource and
 * never enables what that resource's bits refuse, whatever is still pending.
 */
function menuViolations(w: World): string[] {
  const menu = openMenu()
  const opened = w.model.menu
  if (!menu || !opened) return []
  const out: string[] = []
  const node = w.nodes.get(opened.target)
  if (menu.getAttribute('aria-label') !== `Actions for ${opened.name}`) {
    out.push(`S1/H1: the open menu is ${menu.getAttribute('aria-label')}, opened on ${opened.name}`)
  }
  for (const item of within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]) {
    // The Share trigger opens a flyout that also carries Copy link.
    if (item.getAttribute('aria-haspopup')) continue
    const bit = ACTION_BITS[item.textContent?.trim() ?? '']
    if (bit && !item.disabled && node && !node.held.includes(bit)) {
      out.push(`H1/H2: ${item.textContent} is enabled on ${node.name}, which lacks ${bit}`)
    }
  }
  return out
}

function checkAtRest(w: World) {
  const m = w.model
  const violations = [...w.violations, ...menuViolations(w)]
  const menu = openMenu()
  const dialogs = hostDialogs()

  // V1/H1: an open menu names its own resource and offers only what that
  // resource's bits allow.
  if (menu && m.menu && !sameSession(m.menu.origin, m.session)) {
    violations.push(
      `V1: a menu opened under ${sessionKey(m.menu.origin)} is still open in ${sessionKey(m.session)}`
    )
  }

  // Dialogs: only the action the model opened, under a session still live.
  const action = m.action
  if (dialogs.length > 1) violations.push(`DEC-4: ${dialogs.length} host dialogs at once`)
  for (const dialog of dialogs) {
    if (!action) {
      violations.push(
        `S1: a dialog is open with no action chosen: ${dialog.getAttribute('aria-label')}`
      )
      continue
    }
    if (
      !(dialog.textContent ?? '').includes(action.targetName) &&
      !(dialog.getAttribute('aria-label') ?? '').includes(action.targetName)
    ) {
      violations.push(`S1: the ${action.actionId} dialog does not show ${action.targetName}`)
    }
    if (revokedSince(w, action.origin, action.at) || !sameSession(m.session, action.origin)) {
      violations.push(`S3/H26: the ${action.actionId} dialog outlived the session it opened under`)
    }
    if (action.dismissedAt !== null && !action.submitted) {
      violations.push(`E7: the ${action.actionId} dialog survived its dismissal`)
    }
  }
  if (
    action &&
    dialogs.length === 0 &&
    ['rename', 'delete', 'new-folder', 'share', 'move'].includes(action.actionId) &&
    !action.submitted &&
    action.dismissedAt === null &&
    sameSession(m.session, action.origin) &&
    !revokedSince(w, action.origin, action.at) &&
    m.mainGen === action.origin.gen &&
    w.nodes.has(action.target)
  ) {
    violations.push(`L1: the ${action.actionId} dialog for ${action.targetName} never opened`)
  }

  // S6: with the view mounted, it is hidden exactly while a menu or an action covers it.
  if (w.visibility.length > 0) {
    // The OS picker is its own window; what covers the view is the host's
    // picking action, which a revocation or a session change closes.
    const picking =
      m.pickerOpen &&
      action !== null &&
      sameSession(m.session, action.origin) &&
      !revokedSince(w, action.origin, action.at)
    const covered = Boolean(menu) || dialogs.length > 0 || picking
    const visible = w.visibility.at(-1)
    if (visible === covered) {
      violations.push(
        `S6: native view ${visible ? 'shown' : 'hidden'} with menu=${Boolean(menu)} dialog=${dialogs.length} picking=${picking}`
      )
    }
  }

  // L1 and K1 per submission.
  for (const submission of w.submissions) {
    const limit = submission.op === 'createFileFromPath' ? GFS_UPLOAD_NAME_RETRY_LIMIT : 1
    if (submission.calls.length > limit) {
      violations.push(`K1: ${submission.op} sent ${submission.calls.length} times for one submit`)
    }
    const undisturbed =
      sameSession(m.session, submission.origin) &&
      m.mainGen === submission.origin.gen &&
      !revokedSince(w, submission.origin, submission.openedAt) &&
      w.mainSwitches.every(at => at < submission.openedAt) &&
      w.publishes.every(at => at < submission.openedAt)
    if (!undisturbed) continue
    // Closing the dialog while the submit still checks, before anything is
    // sent, cancels it: the user asked for nothing to happen.
    if (submission.calls.length === 0 && (submission.dismissedAt ?? -1) > submission.at) continue
    // A submit may stop before the IPC (a re-check found the resource changed),
    // but never silently.
    const toasted = w.toasts.some(toast => toast.at > submission.at)
    const inlineError = dialogs.some(dialog => dialog.querySelector('.status-banner.tone-error'))
    if (!toasted && !inlineError) {
      violations.push(
        `L1: ${submission.op} on ${submission.target} ended with nothing visible (${submission.calls.length} sent)`
      )
    }
  }
  const hostGenCalls = w.genCalls.filter(call => call.host).length
  const genBudget = w.submissions.reduce(
    (sum, s) => sum + (s.op === 'moveResource' ? MOVE_PIPELINE_CHECKS : s.calls.length) + 1,
    0
  )
  if (hostGenCalls > genBudget) {
    violations.push(`K1: ${hostGenCalls} host generation checks for a budget of ${genBudget}`)
  }
  if (w.hostListAccessible > 0) violations.push('K1: the host listed accessible roots itself')

  // S2/L2: the Files location is the user's, refreshed in place.
  for (const uri of w.locations) {
    if (uri !== QUARTER_URI && uri !== null) violations.push(`S2: Files moved to ${uri}`)
  }
  if (
    m.filesTab.active &&
    m.filesTab.route === QUARTER_URI &&
    accessActive(w, m.session) &&
    !revokedSince(w, m.session, m.filesTab.mountedAt) &&
    m.mainGen === m.session.gen
  ) {
    const expected = pathOf(w.nodes, QUARTER)
    const shown = crumbs()
    if (expected && JSON.stringify(shown) !== JSON.stringify(expected)) {
      violations.push(
        `L2: Files shows ${JSON.stringify(shown)}, the server has ${JSON.stringify(expected)}`
      )
    }
  }

  // S4: an outcome is only shown in the session it belongs to.
  for (const toast of w.toasts) {
    if ((toast as Toast & { legal?: boolean }).legal === false) {
      violations.push(
        `S4: "${toast.message}" shown outside the session that produced it ${(toast as Toast & { why?: string }).why ?? ''}`
      )
    }
  }

  expect(violations).toEqual([])
}

/** S4, judged when the toast is pushed: some source of the live session may show it. */
function judgeToast(w: World, toast: Toast) {
  // The session the renderer has rendered, which is what its guards read.
  const live = w.model.session
  const current = (origin: Session) => sameSession(origin, live) && accessActive(w, live)
  // A mutation's outcome lands after awaits, so main must still run its
  // session; a gesture's immediate feedback (copy link) only needs the
  // session the renderer shows.
  const legal =
    w.submissions.some(
      s => current(s.origin) && mainAdmits(w, s.origin.gen, s.calls.at(-1)?.at ?? s.at)
    ) || w.openings.some(o => current(o.origin))
  ;(toast as Toast & { legal?: boolean }).legal = legal
  if (!legal) {
    ;(toast as Toast & { why?: string }).why = JSON.stringify({
      at: toast.at,
      live,
      mainGen: w.model.mainGen,
      access: w.access,
      switches: w.mainSwitches,
      publishes: w.publishes,
      subs: w.submissions.map(s => ({
        op: s.op,
        origin: s.origin,
        at: s.at,
        calls: s.calls.map(c => c.at),
      })),
      gen: w.genCalls.filter(c => c.host),
    })
  }
}

// ── Commands: the A2 events ─────────────────────────────────────────────────

/** What the generated runs actually reached, so a vacuous pass shows up. */
const coverage = new Map<string, number>()
const cover = (what: string) => coverage.set(what, (coverage.get(what) ?? 0) + 1)

type Cmd = AsyncCommand<Model, World>

/** A user gesture outside a dialog: a host dialog and the OS file picker are modal. */
const modalOpen = (m: Model) => hostDialogs().length > 0 || m.pickerOpen

abstract class OracleEvent implements Cmd {
  check() {
    return true
  }
  abstract perform(m: Model, w: World): Promise<void>
  async run(m: Model, w: World) {
    await this.perform(m, w)
    probeDragDuringMove(w)
    w.violations.push(...menuViolations(w))
  }
  abstract toString(): string
}

/** E1: right-click a row, possibly crossing from the menu of another. */
class OpenMenu extends OracleEvent {
  constructor(readonly pick: number) {
    super()
  }
  async perform(m: Model, w: World) {
    if (modalOpen(m)) return
    const rows = treeRows(w)
    if (rows.length === 0) return
    const row = rows[this.pick % rows.length]!
    const node = nodeByName(w, rowName(row))
    if (!node) return
    const versions = cachedVersions(w, node.id)
    const before = w.affordanceCalls
    tick(w)
    fireEvent.contextMenu(row, { clientX: 20, clientY: 20 })
    await flush()
    if (w.affordanceCalls - before > 2) {
      w.violations.push(`K1: one menu opening read ${w.affordanceCalls - before} affordances`)
    }
    if (openMenu()) cover('menu-opened')
    m.menu = openMenu()
      ? {
          token: ++m.nextToken,
          target: node.id,
          name: node.name,
          versions,
          origin: { ...m.session },
          openedAt: w.clock,
        }
      : null
  }
  toString() {
    return `OpenMenu(${this.pick})`
  }
}

/** E2: one IPC answer lands, the scheduler picks which. */
class Step extends OracleEvent {
  async perform(_m: Model, w: World) {
    if (w.s.count() === 0) return
    await act(async () => {
      await w.s.waitOne()
    })
  }
  toString() {
    return 'Step'
  }
}

/** E3. */
class DismissMenu extends OracleEvent {
  async perform(m: Model, w: World) {
    const menu = openMenu()
    if (!menu) return
    // A host dialog that opened under a menu still on screen hears the same
    // Escape and closes too.
    if (hostDialogs().length > 0 && m.action) m.action.dismissedAt = tick(w)
    fireEvent.keyDown(menu, { key: 'Escape' })
    m.menu = null
    await flush()
  }
  toString() {
    return 'DismissMenu'
  }
}

const ACTION_LABELS: Record<string, string> = {
  rename: 'Rename',
  delete: 'Delete',
  move: 'Move to',
  share: 'Share',
  'new-folder': 'New folder',
  'upload-file': 'Upload file',
  'copy-link': 'Copy link',
}

/** E4: choose an item of the open menu. */
class Choose extends OracleEvent {
  constructor(readonly actionId: string) {
    super()
  }
  async perform(m: Model, w: World) {
    const menu = openMenu()
    if (!menu || !m.menu) return
    const label = ACTION_LABELS[this.actionId]!
    let item = within(menu).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null
    if (!item?.getAttribute('aria-haspopup') && this.actionId === 'copy-link') item = null
    if (this.actionId === 'share' || this.actionId === 'copy-link') {
      // Both live in the Share flyout once it has entries of its own.
      const trigger = (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).find(entry =>
        entry.getAttribute('aria-haspopup')
      )
      if (trigger && !trigger.disabled) {
        fireEvent.click(trigger)
        await flush()
        const flyout = screen.queryByRole('menu', { name: /^Share options for / })
        item = flyout
          ? (within(flyout).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null)
          : null
      } else if (this.actionId === 'copy-link') {
        item = within(menu).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null
      }
    }
    if (!item || item.disabled) return
    const settled = (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).every(
      entry => !entry.disabled
    )
    const opened = m.menu
    const at = tick(w)
    const live = sameSession(opened.origin, m.session) && accessActive(w, m.session)
    // Only a copy toasts straight from the gesture; every other toast is an outcome.
    if (live && this.actionId === 'copy-link') w.openings.push({ origin: opened.origin, at })
    if (live && this.actionId !== 'copy-link') {
      m.action = {
        token: ++m.nextToken,
        actionId: this.actionId,
        target: opened.target,
        targetName: opened.name,
        versions: opened.versions,
        origin: opened.origin,
        at,
        dismissedAt: null,
        submitted: false,
      }
    }
    m.menu = null
    const readsBefore = w.affordanceCalls
    const pickersBefore = w.pickerClicks
    cover(`chose:${this.actionId}`)
    fireEvent.click(item)
    await flush()
    // Only a nested row's menu reads that row's own bits (a root's come with its listing).
    const menuReadOwnBits =
      w.nodes.get(opened.target)?.parent != null && ['rename', 'delete'].includes(this.actionId)
    const stillFresh = w.bitsAgedAt < opened.openedAt
    if (settled && stillFresh && menuReadOwnBits && w.affordanceCalls > readsBefore) {
      w.violations.push(`K1: opening ${this.actionId} re-read bits the menu had just read`)
    }
    if (this.actionId === 'upload-file') m.pickerOpen = w.pickerClicks > pickersBefore
    if (this.actionId === 'upload-file' && live !== m.pickerOpen) {
      w.violations.push(
        `E4: the picker ${m.pickerOpen ? 'opened' : 'did not open'} for a ${live ? 'live' : 'stale'} choice`
      )
    }
  }
  toString() {
    return `Choose(${this.actionId})`
  }
}

function submit(m: Model, w: World, op: MutationOp, action: ModelAction): Submission {
  const submission: Submission = {
    id: w.submissions.length + 1,
    op,
    target: action.target,
    versions: action.versions,
    origin: action.origin,
    openedAt: action.at,
    at: tick(w),
    calls: [],
    actionToken: action.token,
    dismissedAt: null,
  }
  w.submissions.push(submission)
  cover(`submitted:${op}`)
  action.submitted = true
  return submission
}

/** E6: fill and submit the open dialog. */
class Submit extends OracleEvent {
  constructor(readonly n: number) {
    super()
  }
  async perform(m: Model, w: World) {
    const action = m.action
    const dialogs = hostDialogs()
    if (!action || dialogs.length !== 1) return
    const dialog = dialogs[0]!
    const button = (name: string | RegExp) =>
      within(dialog).queryByRole('button', { name }) as HTMLButtonElement | null
    if (action.actionId === 'rename' || action.actionId === 'new-folder') {
      const rename = action.actionId === 'rename'
      const input = within(dialog).queryByLabelText(rename ? 'Name' : 'Folder name')
      if (!input) return
      const current = w.nodes.get(action.target)?.name ?? action.targetName
      fireEvent.change(input, {
        target: {
          value: rename ? `${current.replace(/-r\d+$/, '')}-r${this.n}` : `Folder ${this.n}`,
        },
      })
      const save = button(rename ? 'Save' : 'Create folder')
      if (!save || save.disabled) return
      submit(m, w, rename ? 'renameResource' : 'createFolder', action)
      fireEvent.click(save)
    } else if (action.actionId === 'delete') {
      const confirm = button('Delete')
      if (!confirm || confirm.disabled) return
      submit(m, w, 'deleteResource', action)
      fireEvent.click(confirm)
    } else if (action.actionId === 'move') {
      const node = w.nodes.get(action.target)
      if (!node) return
      const destinationId = node.parent === ARCHIVE ? DOCS : ARCHIVE
      const destination = w.nodes.get(destinationId)
      if (!destination || destinationId === action.target) return
      // Destinations come from a listing the scheduler does not hold back.
      let pickDestination = button(destination.name)
      for (let wait = 0; wait < 6 && !pickDestination; wait += 1) {
        await act(async () => {
          await sleep(10)
        })
        pickDestination = button(destination.name)
      }
      if (!pickDestination) return
      fireEvent.click(pickDestination)
      await flush()
      const move = button(`Move here (${destination.name})`)
      if (!move || move.disabled) return
      submit(m, w, 'moveResource', action)
      fireEvent.click(move)
    } else {
      return
    }
    await flush()
  }
  toString() {
    return `Submit(${this.n})`
  }
}

/** E7: Cancel or close the open dialog. */
class DismissDialog extends OracleEvent {
  async perform(m: Model, w: World) {
    const dialogs = hostDialogs()
    if (dialogs.length !== 1) return
    const close = within(dialogs[0]!).queryAllByRole('button', {
      name: /^(Cancel|Close move dialog|Close share dialog)$/,
    })[0]
    if (!close) return
    const action = m.action
    const running =
      action !== null &&
      w.submissions.some(s => s.actionToken === action.token && s.calls.some(call => !call.settled))
    if (action) {
      action.dismissedAt = tick(w)
      for (const s of w.submissions) {
        if (s.actionToken === action.token) s.dismissedAt = action.dismissedAt
      }
    }
    fireEvent.click(close)
    await flush()
    // A mutation cannot be recalled: closing is ignored while it runs.
    if (running && hostDialogs().length === 0) {
      w.violations.push(`H4/H18: closing the ${action!.actionId} dialog took effect while it ran`)
    }
  }
  toString() {
    return 'DismissDialog'
  }
}

/** E5: the OS picker returns a file or is cancelled. */
class Pick extends OracleEvent {
  constructor(readonly file: string | null) {
    super()
  }
  async perform(m: Model, w: World) {
    if (!m.pickerOpen || !m.action) return
    m.pickerOpen = false
    const input = screen.getByTestId('gfs-action-host-upload-input')
    if (this.file === null) {
      m.action.dismissedAt = tick(w)
      await act(async () => {
        input.dispatchEvent(new window.Event('cancel'))
      })
      return
    }
    submit(m, w, 'createFileFromPath', m.action)
    fireEvent.change(input, { target: { files: [new File(['data'], this.file)] } })
    await flush()
  }
  toString() {
    return `Pick(${this.file})`
  }
}

/** E8: a 401 elsewhere revokes this session, same generation, through the real lib. */
class Revoke extends OracleEvent {
  async perform(m: Model, w: World) {
    const session = m.session
    w.access.push({ at: tick(w), session: sessionKey(session), kind: 'revoke' })
    await act(async () => {
      revokeGfsSessionAccess(w.queryClient, scopeOf(session.team), session.gen)
    })
  }
  toString() {
    return 'Revoke'
  }
}

/** E8: the watch reports the session expired. */
class SessionExpired extends OracleEvent {
  async perform(m: Model, w: World) {
    w.access.push({ at: tick(w), session: sessionKey(m.session), kind: 'expired' })
    await act(async () => {
      w.watch.deliver(sessionExpiredEvents)
    })
  }
  toString() {
    return 'SessionExpired'
  }
}

/** The tree's "Retry file access": same session, same generation. */
class RetryAccess extends OracleEvent {
  async perform(m: Model, w: World) {
    if (modalOpen(m)) return
    const retry = retryButton()
    if (!retry) return
    w.access.push({ at: tick(w), session: sessionKey(m.session), kind: 'retry' })
    fireEvent.click(retry)
    await flush()
  }
  toString() {
    return 'RetryAccess'
  }
}

/**
 * E8: a team switch. Main runs the new session at once; the renderer
 * publishes it whenever the scheduler lets that land.
 */
class SwitchTeam extends OracleEvent {
  /** False: the renderer publishes only on `PublishHeldSession`, never by the scheduler. */
  constructor(readonly scheduledPublish = true) {
    super()
  }
  async perform(m: Model, w: World) {
    if (m.pendingPublish) return
    m.mainGen += 1
    w.mainSwitches.push(tick(w))
    m.pendingPublish = true
    const next: Session = {
      team: m.session.team === 'team-a' ? 'team-b' : 'team-a',
      gen: m.mainGen,
    }
    if (!this.scheduledPublish) {
      w.heldPublish = () => w.store.set(next)
      return
    }
    void w.s.schedule(Promise.resolve(), 'publish-session').then(() => w.store.set(next))
  }
  toString() {
    return 'SwitchTeam'
  }
}

/** E9: another client writes a resource; the watch reports its folder changed. */
class RemoteChange extends OracleEvent {
  constructor(readonly pick: number) {
    super()
  }
  async perform(_m: Model, w: World) {
    const candidates = [...w.nodes.values()].filter(
      n => n.parent && WATCHED_DIRS.includes(n.parent)
    )
    if (candidates.length === 0) return
    const node = candidates[this.pick % candidates.length]!
    node.version += 1
    tick(w)
    const events = changedEvents.get(node.parent!)
    if (events) {
      await act(async () => {
        w.watch.deliver(events)
      })
    }
  }
  toString() {
    return `RemoteChange(${this.pick})`
  }
}

/** E10: the Files tab is left or re-entered (it remounts on its saved route). */
class ToggleFilesTab extends OracleEvent {
  async perform(m: Model, w: World) {
    if (m.pickerOpen) return
    m.filesTab.active = !m.filesTab.active
    if (m.filesTab.active) {
      m.filesTab.route = w.locations.length > 0 ? (w.locations.at(-1) ?? null) : QUARTER_URI
      m.filesTab.mountedAt = tick(w)
    }
    const ui = w.ui.get()
    await act(async () => {
      w.ui.set({ filesActive: m.filesTab.active, filesMount: ui.filesMount + 1 })
    })
  }
  toString() {
    return 'ToggleFilesTab'
  }
}

/** E12: the explorer is collapsed or reopened. */
class ToggleTree extends OracleEvent {
  async perform(m: Model, w: World) {
    if (m.pickerOpen) return
    m.treeMounted = !m.treeMounted
    if (!m.treeMounted) m.menu = null
    tick(w)
    await act(async () => {
      w.ui.set({ treeMounted: m.treeMounted })
    })
  }
  toString() {
    return 'ToggleTree'
  }
}

/** Expand a folder of the tree, so its rows can be acted on. */
class Expand extends OracleEvent {
  constructor(readonly pick: number) {
    super()
  }
  async perform(m: Model, _w?: World) {
    if (modalOpen(m)) return
    const root = tree()
    if (!root) return
    const toggles = within(root).queryAllByRole('button', { name: /^Expand / })
    if (toggles.length === 0) return
    fireEvent.click(toggles[this.pick % toggles.length]!)
    await flush()
  }
  toString() {
    return `Expand(${this.pick})`
  }
}

/** E14: start (and end) a drag of a row. */
class Drag extends OracleEvent {
  constructor(readonly pick: number) {
    super()
  }
  async perform(m: Model, w: World) {
    if (m.pickerOpen) return
    const rows = treeRows(w)
    if (rows.length === 0) return
    const row = rows[this.pick % rows.length]!
    const transfer = { types: [] as string[], effectAllowed: 'none', setData: vi.fn() }
    fireEvent.dragStart(row, { dataTransfer: transfer })
    fireEvent.dragEnd(row, { dataTransfer: transfer })
    await flush()
  }
  toString() {
    return `Drag(${this.pick})`
  }
}

/**
 * The user carrying a gesture on: submit an open dialog, otherwise choose from
 * an open menu (waiting one answer while its item is still inert), otherwise
 * open a menu. Keeps generated runs reaching mutations without fixing their
 * interleaving with every other event.
 */
class Advance extends OracleEvent {
  override async run(m: Model, w: World) {
    cover(
      `advance:${hostDialogs().length > 0 ? 'dialog' : openMenu() ? 'menu' : m.pickerOpen ? 'picker' : m.action && !m.action.submitted && m.action.dismissedAt === null && w.s.count() > 0 ? 'wait' : 'open'}`
    )
    await super.run(m, w)
  }
  constructor(
    readonly pick: number,
    readonly actionId: string,
    readonly n: number
  ) {
    super()
  }
  async perform(m: Model, w: World) {
    if (m.pickerOpen) {
      await new Pick(
        this.n % 3 === 0 ? null : this.n % 3 === 1 ? 'notes.txt' : 'report.txt'
      ).perform(m, w)
      return
    }
    if (hostDialogs().length > 0) {
      // A submit in flight: the user waits for it.
      const action = m.action
      if (action?.submitted && w.s.count() > 0) {
        const sent = w.submissions.some(
          s => s.actionToken === action.token && s.calls.some(call => !call.settled)
        )
        // Once the request is out the user may try to close the dialog;
        // main may switch session meanwhile (another window, an expiry).
        // A Move reaches its request rarely; give its close attempt better odds.
        const tryClose = this.n % 3 === 0 || (action.actionId === 'move' && this.n % 2 === 0)
        if (sent && tryClose) await new DismissDialog().perform(m, w)
        else if (sent && this.n % 7 === 1) await new SwitchTeam().perform(m, w)
        else await new Step().perform(m, w)
        return
      }
      const submissions = w.submissions.length
      await new Submit(this.n).perform(m, w)
      // Nothing to submit here (Share, or no destination): the user leaves.
      if (w.submissions.length === submissions) await new DismissDialog().perform(m, w)
      return
    }
    const menu = openMenu()
    // An action still checking its authority: wait for it rather than replace it.
    if (
      !menu &&
      m.action &&
      !m.action.submitted &&
      m.action.dismissedAt === null &&
      w.s.count() > 0
    ) {
      await new Step().perform(m, w)
      return
    }
    if (menu) {
      const inert = (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).some(
        i => i.disabled
      )
      if (inert && w.s.count() > 0) {
        // Sometimes the user right-clicks another row before the bits land.
        if (this.n % 4 === 0) {
          // Half the time onto the read-only row, whose bits differ most.
          const rows = treeRows(w).map(rowName)
          const readOnly = rows.indexOf('readme.md')
          await new OpenMenu(this.n % 8 === 0 && readOnly >= 0 ? readOnly : this.pick + 1).perform(
            m,
            w
          )
        } else await new Step().perform(m, w)
        return
      }
      // Prefer the drawn action; otherwise take one the menu does offer.
      const offered = Object.entries(ACTION_LABELS)
        .filter(([, label]) =>
          (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).some(
            item => !item.disabled && item.textContent?.trim() === label
          )
        )
        .map(([id]) => id)
      if (offered.includes('share')) offered.push('copy-link')
      const actionId =
        offered.includes(this.actionId) || offered.length === 0
          ? this.actionId
          : offered[this.n % offered.length]!
      await new Choose(actionId).perform(m, w)
      return
    }
    // Get back to rows to act on: reopen the explorer, retry access, expand.
    if (!m.treeMounted) {
      await new ToggleTree().perform(m, w)
      return
    }
    const root = tree()
    if (retryButton()) {
      await new RetryAccess().perform(m, w)
      return
    }
    if (
      treeRows(w).length < 3 &&
      root &&
      within(root).queryAllByRole('button', { name: /^Expand / }).length > 0
    ) {
      await new Expand(0).perform(m, w)
      return
    }
    // Listings are not ordered by the scheduler: give a loading tree a moment.
    if (treeRows(w).length === 0) {
      await act(async () => {
        await sleep(15)
      })
    }
    await new OpenMenu(this.pick).perform(m, w)
  }
  toString() {
    return `Advance(${this.pick},${this.actionId},${this.n})`
  }
}

/**
 * Time passes: every cached bit read goes stale, as it does after the
 * authority freshness window, so the next menu opening reads again.
 */
class BitsAge extends OracleEvent {
  async perform(_m: Model, w: World) {
    w.bitsAgedAt = tick(w)
    await act(async () => {
      await w.queryClient.invalidateQueries({
        predicate: query => query.queryKey[3] === 'affordances',
        refetchType: 'none',
      })
    })
  }
  toString() {
    return 'BitsAge'
  }
}

/** Let everything land, then compare with the model. */
class Rest extends OracleEvent {
  async perform(_m: Model, w: World) {
    await rest(w)
    checkAtRest(w)
  }
  toString() {
    return 'Rest'
  }
}

// ── Fixed examples: interleavings every run must include ────────────────────

/** E1 on a row named by the example rather than by position. */
class OpenMenuOn extends OracleEvent {
  constructor(readonly name: string) {
    super()
  }
  async perform(m: Model, w: World) {
    const index = treeRows(w).map(rowName).indexOf(this.name)
    if (index >= 0) await new OpenMenu(index).perform(m, w)
  }
  toString() {
    return `OpenMenuOn(${this.name})`
  }
}

/** Holds a resource's next bit reads until `ReleaseBits`. */
class HoldBits extends OracleEvent {
  constructor(readonly resourceId: string) {
    super()
  }
  async perform(_m: Model, w: World) {
    w.heldBits.set(
      this.resourceId,
      new Promise<void>(resolve => w.releaseBits.set(this.resourceId, resolve))
    )
  }
  toString() {
    return `HoldBits(${this.resourceId.slice(0, 4)})`
  }
}

class ReleaseBits extends OracleEvent {
  constructor(readonly resourceId: string) {
    super()
  }
  async perform(_m: Model, w: World) {
    w.heldBits.delete(this.resourceId)
    w.releaseBits.get(this.resourceId)?.()
    await act(async () => {
      await sleep(10)
    })
  }
  toString() {
    return `ReleaseBits(${this.resourceId.slice(0, 4)})`
  }
}

class PublishHeldSession extends OracleEvent {
  async perform(_m: Model, w: World) {
    const publish = w.heldPublish
    w.heldPublish = null
    await act(async () => {
      publish?.()
    })
  }
  toString() {
    return 'PublishHeldSession'
  }
}

/** Lets answers land one by one until a host mutation of `op` is out. */
class StepUntilSent extends OracleEvent {
  constructor(readonly op: MutationOp) {
    super()
  }
  async perform(m: Model, w: World) {
    for (let step = 0; step < 50 && !w.calls.some(call => call.op === this.op); step += 1) {
      if (w.s.count() === 0) {
        await act(async () => {
          await sleep(10)
        })
        continue
      }
      await new Step().perform(m, w)
    }
  }
  toString() {
    return `StepUntilSent(${this.op})`
  }
}

/** Closing the Move dialog while its PATCH is in flight (H18, V6). */
const closeDuringMove = (): Cmd[] => [
  new OpenMenuOn('Quarterly'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('moveResource'),
  new DismissDialog(),
  new Rest(),
]

/** Bits of one row landing after the user moved on to the read-only row (H1). */
const lateBitsOnCrossedMenu = (): Cmd[] => [
  new HoldBits(NOTES),
  new OpenMenuOn('notes.txt'),
  new OpenMenuOn('readme.md'),
  new Rest(),
  new ReleaseBits(NOTES),
  new Rest(),
]

/** A rename landing after main switched session, before the renderer publishes it (S4). */
const outcomeWhileMainIsAhead = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('rename'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('renameResource'),
  new SwitchTeam(false),
  new Rest(),
  new PublishHeldSession(),
  new Rest(),
]

/** One committed host Move and nothing else, to measure its generation checks. */
const oneCommittedMove = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new Submit(1),
  new Rest(),
]

/**
 * A host Move runs the commit pipeline it shares with the tree's drag, which
 * asks main for the generation before and after each of its steps (the
 * dialog's pre-check, source resolve, dispatch, convergence) rather than once
 * per operation. Measured on one committed Move by the test below, which
 * fails if the pipeline's count drifts; the host's own outcome check is the +1.
 */
const MOVE_PIPELINE_CHECKS = 8

const exampleScheduler = () => fc.sample(fc.scheduler(), { seed: 2611, numRuns: 1 })[0]!

const pick = fc.nat({ max: 11 })
const advanceWith = (...actionIds: string[]) =>
  fc
    .tuple(pick, fc.constantFrom(...actionIds), fc.nat({ max: 99 }))
    .map(([p, id, n]) => new Advance(p, id, n) as Cmd)
const times = (count: number, arbitrary: fc.Arbitrary<Cmd>) =>
  Array.from({ length: count }, () => arbitrary)
const step = fc.constant(new Step() as Cmd)
const rest_ = fc.constant(new Rest() as Cmd)

/** Every A2 event, with the user mostly carrying a gesture on. */
const allEvents = [
  ...times(
    14,
    advanceWith(
      'rename',
      'delete',
      'move',
      'move',
      'move',
      'new-folder',
      'upload-file',
      'share',
      'copy-link'
    )
  ),
  pick.map(p => new OpenMenu(p) as Cmd),
  ...times(2, step),
  fc.constantFrom(...Object.keys(ACTION_LABELS)).map(id => new Choose(id) as Cmd),
  fc.nat({ max: 99 }).map(n => new Submit(n) as Cmd),
  fc.constant(new DismissMenu() as Cmd),
  fc.constant(new DismissDialog() as Cmd),
  fc.constantFrom<string | null>('notes.txt', 'report.txt', null).map(f => new Pick(f) as Cmd),
  fc.constant(new Revoke() as Cmd),
  fc.constant(new SessionExpired() as Cmd),
  fc.constant(new RetryAccess() as Cmd),
  ...times(2, fc.constant(new SwitchTeam() as Cmd)),
  pick.map(p => new RemoteChange(p) as Cmd),
  fc.constant(new ToggleFilesTab() as Cmd),
  fc.constant(new ToggleTree() as Cmd),
  pick.map(p => new Expand(p) as Cmd),
  pick.map(p => new Drag(p) as Cmd),
  fc.constant(new BitsAge() as Cmd),
  rest_,
]

/** Menus opened and crossed while their bits are still in flight (V1, H1, H2). */
const menuEvents = [
  ...times(6, advanceWith('rename', 'delete', 'share')),
  ...times(3, fc.constant(new BitsAge() as Cmd)),
  ...times(
    3,
    pick.map(p => new OpenMenu(p) as Cmd)
  ),
  ...times(3, step),
  fc.constant(new DismissMenu() as Cmd),
  fc.constant(new SwitchTeam() as Cmd),
  fc.constant(new Revoke() as Cmd),
  fc.constant(new RetryAccess() as Cmd),
  rest_,
]

/** A host Move against its interleavings: close attempts, drags, session changes (V6, H18). */
const moveEvents = [
  ...times(10, advanceWith('move')),
  step,
  ...times(2, fc.constant(new DismissDialog() as Cmd)),
  pick.map(p => new Drag(p) as Cmd),
  fc.constant(new SwitchTeam() as Cmd),
  fc.constant(new Revoke() as Cmd),
  pick.map(p => new RemoteChange(p) as Cmd),
  rest_,
]

// ── Setup ───────────────────────────────────────────────────────────────────

async function mountWorld(s: Scheduler): Promise<World> {
  const session = storeOf<Session>({ team: 'team-a', gen: 1 })
  const ui = storeOf<UiState>({ filesActive: true, filesMount: 0, treeMounted: true })
  const queryClient = new QueryClient({ defaultOptions: desktopQueryDefaults })
  const w: World = {
    s,
    clock: 0,
    nodes: seedServer(),
    nextId: 0,
    model: {
      session: { team: 'team-a', gen: 1 },
      mainGen: 1,
      pendingPublish: false,
      menu: null,
      action: null,
      pickerOpen: false,
      filesTab: { active: true, mountedAt: 0, route: QUARTER_URI },
      treeMounted: true,
      nextToken: 0,
    },
    store: session,
    ui: {
      get: ui.get,
      set: next => ui.set({ ...ui.get(), ...next }),
      subscribe: ui.subscribe,
    },
    queryClient,
    calls: [],
    submissions: [],
    toasts: [],
    genCalls: [],
    mainSwitches: [],
    publishes: [],
    access: [],
    locations: [],
    visibility: [],
    affordanceCalls: 0,
    hostListAccessible: 0,
    pickerClicks: 0,
    heldPublish: null,
    heldBits: new Map(),
    releaseBits: new Map(),
    bitsAgedAt: -1,
    openings: [],
    violations: [],
    watch: watchSource.connectRenderer(),
    embed: createPageEmbed(),
  }
  installBridge(w)
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
    w.pickerClicks += 1
  })
  render(
    <QueryClientProvider client={queryClient}>
      <Shell world={w} />
    </QueryClientProvider>
  )
  for (
    let pass = 0;
    pass < 20 && !screen.queryByRole('button', { name: 'Expand Docs' });
    pass += 1
  ) {
    await rest(w)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Expand Docs' }))
  for (let pass = 0; pass < 20 && treeRows(w).length < 5; pass += 1) await rest(w)
  await rest(w)
  expect(crumbs()).toEqual(['Docs', 'Quarterly'])
  expect(treeRows(w).map(rowName).sort()).toEqual(
    ['Archive', 'Docs', 'Quarterly', 'notes.txt', 'readme.md'].sort()
  )
  expect(w.visibility.at(-1)).toBe(true)
  expect(w.violations).toEqual([])
  return w
}

function recordCoverage(w: World) {
  for (const call of w.calls) cover(`call:${call.op}`)
  for (const submission of w.submissions) {
    if (submission.calls.length === 0) cover(`blocked:${submission.op}`)
  }
  for (const toast of w.toasts) cover(`toast:${toast.tone}`)
  if (w.publishes.length > 0) cover('team-published')
  if (w.mainSwitches.length > w.publishes.length) cover('main-ahead-at-end')
  for (const event of w.access) cover(`access:${event.kind}`)
  if (
    w.toasts.some(t => /changed since/.test(t.message)) ||
    (w.calls.length > 0 && hostDialogs().some(d => /changed since/.test(d.textContent ?? '')))
  )
    cover('cas-412')
  if (w.locations.length > 0) cover('files-location')
}

async function unmountWorld(w: World) {
  recordCoverage(w)
  cleanup()
  w.queryClient.clear()
  await sleep(0)
  vi.restoreAllMocks()
  delete (window as { clerum?: unknown }).clerum
}

beforeAll(async () => {
  failures = {
    stale: await gfsRouteFailureMessage(
      client =>
        client.renameResource(
          { resourceId: NOTES, drive: 'main', newName: 'x', ifMatch: 1 },
          'fixture-session-token'
        ),
      412,
      { code: 'version_conflict', message: 'the resource changed since it was read' }
    ),
    conflict: await gfsRouteFailureMessage(
      client =>
        client.createResource(
          { parentResourceId: DOCS, drive: 'main', name: 'x', kind: 'file' },
          'fixture-session-token'
        ),
      409,
      { code: 'name_conflict', message: 'an item with this name already exists' }
    ),
    notFound: await gfsRouteFailureMessage(
      client => client.resolveUri(uriOf(NOTES), 'fixture-session-token'),
      404,
      { code: 'not_found', message: 'resource not found' }
    ),
  }
  watchSource = await new GfsWatchEventSource().start(
    WATCHED_DIRS.map(id => mainDriveKey('dir', id))
  )
  for (const id of WATCHED_DIRS) {
    changedEvents.set(id, await watchSource.changed([mainDriveKey('dir', id)]))
  }
  const expiring = await new GfsWatchEventSource().start([mainDriveKey('dir', DOCS)])
  try {
    sessionExpiredEvents = await expiring.sessionExpired([mainDriveKey('dir', DOCS)])
  } finally {
    await expiring.stop()
  }
  expect(sessionExpiredEvents.some(event => event.type === 'sessionExpired')).toBe(true)
  for (const events of changedEvents.values()) {
    expect(events.some(event => event.type === 'changed')).toBe(true)
  }
}, 30_000)

beforeAll(() => {
  // jsdom paints no frames and observes no resizes.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0)
    return 1
  })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }
  )
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await watchSource?.stop()
})

afterEach(() => {
  cleanup()
})

const RUNS = Number(process.env.GFS_ACTION_ORACLE_RUNS ?? 80)
const SEED = process.env.GFS_ACTION_ORACLE_SEED
  ? Number(process.env.GFS_ACTION_ORACLE_SEED)
  : undefined

async function checkGenerated(
  events: fc.Arbitrary<Cmd>[],
  numRuns: number,
  maxCommands: number,
  examples: Array<() => Cmd[]> = []
) {
  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.commands(events, { maxCommands, size: 'max' }),
      async (s, commands) => {
        const w = await mountWorld(s)
        try {
          await fc.asyncModelRun(() => ({ model: w.model, real: w }), commands)
          await rest(w)
          checkAtRest(w)
        } finally {
          await unmountWorld(w)
        }
      }
    ),
    {
      numRuns,
      seed: SEED,
      endOnFailure: false,
      examples: examples.map(build => [exampleScheduler(), build()] as [Scheduler, Iterable<Cmd>]),
    }
  )
}

describe('GfsActionHost — model-based oracle (A6)', () => {
  it('keeps S1–S6, L1, L2 and K1 at rest under generated events and IPC orders', async () => {
    await checkGenerated(allEvents, RUNS, 36, [outcomeWhileMainIsAhead])
    process.stdout.write(
      `gfs action oracle coverage: ${JSON.stringify(Object.fromEntries([...coverage].sort()))}\n`
    )
    // Guard against a vacuous pass without pinning each rare path to a
    // random draw: most operations must have reached main, and succeeded.
    const ops = [
      'renameResource',
      'deleteResource',
      'createFolder',
      'moveResource',
      'createFileFromPath',
    ]
    const reached = ops.filter(op => (coverage.get(`call:${op}`) ?? 0) > 0)
    expect(
      reached.length,
      `operations that reached main: ${reached.join(', ')}`
    ).toBeGreaterThanOrEqual(3)
    expect(coverage.get('toast:success') ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('keeps a row menu on its own resource and bits across crossed openings', async () => {
    await checkGenerated(menuEvents, Math.ceil(RUNS / 4), 20, [lateBitsOnCrossedMenu])
  }, 300_000)

  it('keeps a running host Move in its dialog and its resource undraggable', async () => {
    coverage.clear()
    await checkGenerated(moveEvents, Math.ceil(RUNS / 2), 24, [closeDuringMove])
    expect(coverage.get('call:moveResource') ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('measures the generation checks of one committed host Move (K1 bound for Move)', async () => {
    const w = await mountWorld(exampleScheduler())
    try {
      await fc.asyncModelRun(() => ({ model: w.model, real: w }), oneCommittedMove())
      await rest(w)
      checkAtRest(w)
      expect(w.calls.filter(call => call.op === 'moveResource')).toHaveLength(1)
      expect(w.toasts.map(toast => toast.tone)).toEqual(['success'])
      expect(w.genCalls.filter(call => call.host)).toHaveLength(MOVE_PIPELINE_CHECKS + 1)
    } finally {
      await unmountWorld(w)
    }
  }, 60_000)
})
