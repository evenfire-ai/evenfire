// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@contexts/AuthContext'
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import fc, { type AsyncCommand, type Scheduler } from 'fast-check'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GFS_UPLOAD_NAME_RETRY_LIMIT } from '@clerum/gfs-interaction-policy'
import { FileExplorerTree } from '@components/SidebarNav/FileExplorerTree'
import { GFS_WATCH_DEBOUNCE_MS } from '@constants/gfsWatch'
import { GFS_UNAVAILABLE_LOCATION_MESSAGE } from '@hooks/domain/useGfsBrowserController'
import { useGfsWatchSubscription } from '@hooks/domain/useGfsWatchSubscription'
import { useGfsWatchKeyReactions } from '@hooks/useGfsWatchKeyReactions'
import { describeGfsReadError } from '@lib/gfsGrantErrors'
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
  downloadResult,
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
import { DesktopUploadCapabilityError } from '../../../../../src/gfs/upload.js'
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

/** What `gfs.revokeGrant` resolves to, through the real GfsClient. */
async function revokeGrantReceipt(grantId: string) {
  const client = new GfsClient({
    baseUrl: 'https://gfs.fixture.test',
    requestJson: async () => ({ ok: true, data: {} }) as never,
    fetchBytes: async () => new ArrayBuffer(0),
  })
  return structuredClone(await client.revokeGrant(grantId, 'fixture-session-token'))
}

/** The agent every root folder is shared with, as a Share row names it. */
const AGENT_NAME = 'chatllm'
const AGENT_SUBJECT = { type: 'host' as const, id: '1st:mcp-host/chatllm' }
let myAgents: unknown[] = []

/** What `agents.listMine` resolves to, through AppService's real listing. */
async function myAgentsListing() {
  const service = Object.create(AppService.prototype) as AppService
  Object.assign(service, {
    sessionToken: 'fixture-session-token',
    authClient: {
      getMyAgents: async () => ({
        agents: [
          { name: AGENT_NAME, contextRef: 'ctx-1', mcpServers: [], gfsSubject: AGENT_SUBJECT },
        ],
      }),
    },
  })
  return structuredClone(await service.listMyAgents())
}

let uploadSource = ''

/**
 * What `gfs.createFileFromPath` resolves to, through AppService's real
 * create-from-path on the legacy fallback (the resumable session is not
 * available here): a real local file, the real GfsClient create, and the
 * session receipt main returns for it.
 */
async function uploadReceipt(
  parentResourceId: string,
  name: string,
  created: ReturnType<typeof childView>
) {
  const service = Object.create(AppService.prototype) as AppService
  const identity = { ownerId: 'user-a', teamId: 'team-a', envKey: '' }
  Object.assign(service, {
    sessionToken: 'fixture-session-token',
    me: { id: 'user-a' },
    gfsDispatchBlocked: false,
    gfsScopeIdentity: identity,
    gfsAuthEpoch: 1,
    gfsPendingLegacyUploads: new Set(),
    gfsUploadJobs: new Map(),
    assertGfsDispatchAllowed: () => undefined,
    startDesktopGfsUpload: async () => {
      throw new DesktopUploadCapabilityError('resumable upload unavailable', {
        allowLegacyFallback: true,
      })
    },
    gfsClient: new GfsClient({
      baseUrl: 'https://gfs.fixture.test',
      requestJson: async () => ({ ok: true, data: created }) as never,
      fetchBytes: async () => new ArrayBuffer(0),
    }),
  })
  return structuredClone(
    await service.createGfsFileFromPath(parentResourceId, name, uploadSource, 'main')
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
  | 'revokeGrant'

interface MutationCall {
  op: MutationOp
  target: string
  ifMatch?: number
  at: number
  settled: boolean
  settledAt?: number
  rejected?: boolean
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
  /** The resource's name when submitted, as outcome toasts name it. */
  name: string
  /** Toast texts that are this submission's outcome. */
  outcomes: Set<string>
  /** An outcome toast was attributed to it. */
  toasted: boolean
  /** When the latest toast attributed to it was pushed. */
  toastedAt: number | null
  /** An error banner in its own dialog showed its outcome. */
  shownInline: boolean
  /** That banner refused a Move whose source changed since it was chosen. */
  refusedAsChanged: boolean
  /** When its dialog actually closed on the user's request, if it did. */
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
  /** Whether a source that may show it was found when it was pushed (S4). */
  legal?: boolean
  why?: string
}

interface GenCall {
  at: number
  answer: number
  host: boolean
  /** Which kind of host action asked, read from the stack (see `askingFamily`). */
  family: ActionFamily | null
}

type ActionFamily = 'move' | 'upload' | 'dialog' | 'share' | 'gesture'

/** An action that opens no surface: its only outcome is a toast. */
type GestureId = 'copy-link' | 'download'
const GESTURES = new Set<string>(['copy-link', 'download'])

interface Gesture {
  actionId: GestureId
  name: string
  origin: Session
  at: number
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
  /** Copies and downloads chosen in a live session. */
  openings: Gesture[]
  /** Root folder -> id of the agent grant its Share dialog can remove. */
  grants: Map<string, string>
  /** The Move generation check during which a fixed example revokes access. */
  revokeAtMoveCheck: number | null
  moveChecksSeen: number
  /** A resource another client writes just before the next Move PATCH of it. */
  changeBeforeNextMove: string | null
  /**
   * A fixed example's extra host generation check: called with the stack of
   * each real check, it returns the stack to record one more check under, or
   * null for none.
   */
  extraGenCheck: ((stack: string | undefined) => string | null) | null
  /** A generation answer a fixed example releases by hand. */
  heldGen: { promise: Promise<void>; release: () => void } | null
  releaseGen: (() => void) | null
  /** Location reads of Q: when each started and settled. */
  qReads: Array<{ start: number; end: number | null }>
  /** Events that can make Files re-read Q; a mutation landing opens a K1 window. */
  triggers: Array<{ at: number; mutation: boolean }>
  /** Watch events delivered as the next read of Q starts. */
  echoOnQRead: GfsWatchEvent[] | null
  /** The watched keys as rendered; main receives them after the watch's debounce. */
  renderedKeys: string
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
 * It reads source file names from the stack, so a rename of those modules
 * silently stops attributing: the per-submission K1 budget would then pass
 * vacuously, which the measured Move count below catches.
 */
const askedByHost = (stack: string | undefined) => {
  const frames = (stack ?? '')
    .split('\n')
    .filter(line => line.includes('/ui/src/') && !line.includes('__tests__'))
    .filter(line => !line.includes('lib/gfsSessionAuthority'))
  return Boolean(frames[0] && HOST_CODE.test(frames[0]))
}

/**
 * Which host action a generation check belongs to, by the code on its stack:
 * the Move pipeline and its dialog, the upload loop, a write of the Share dialog, a copy's or
 * a download's toast, or the one dialog action (rename, delete, new folder) the host runs at a
 * time. Same file-name dependence as `askedByHost`; a download is told by its function name.
 */
function askingFamily(stack: string | undefined): ActionFamily | null {
  if (!askedByHost(stack)) return null
  const text = stack ?? ''
  if (/explicitMoveDialog|moveCommit|useGfsResourceOperations/.test(text)) return 'move'
  if (/runGfsUpload|runUpload/.test(text)) return 'upload'
  if (/manageAccessDialog/.test(text)) return 'share'
  if (/gfsResourceClipboard|\bat download \(/.test(text)) return 'gesture'
  return 'dialog'
}

const familyOf = (op: MutationOp): ActionFamily =>
  op === 'moveResource'
    ? 'move'
    : op === 'createFileFromPath'
      ? 'upload'
      : op === 'revokeGrant'
        ? 'share'
        : 'dialog'

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

function recordMutation(
  w: World,
  op: MutationOp,
  target: string,
  ifMatch?: number,
  outcome?: string
) {
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
  if (
    submission.calls.length === 0 &&
    submission.dismissedAt !== null &&
    submission.dismissedAt < at
  ) {
    w.violations.push(`S3: ${op} started after its dialog was closed`)
  }
  if (outcome) submission.outcomes.add(outcome)
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

function settleWhenAnswered<T>(w: World, call: MutationCall, promise: Promise<T>): Promise<T> {
  return promise.then(
    value => {
      call.settled = true
      call.settledAt = tick(w)
      w.triggers.push({ at: call.settledAt, mutation: true })
      return value
    },
    error => {
      call.settled = true
      call.rejected = true
      call.settledAt = tick(w)
      // A rejected request's own message is what the host shows for it.
      call.submission?.outcomes.add(error instanceof Error ? error.message : String(error))
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
      targetOf: (...args: A) => { target: string; ifMatch?: number; outcome?: string },
      apply: (...args: A) => Promise<R>
    ) =>
    (...args: A) => {
      const { target, ifMatch, outcome } = targetOf(...args)
      const call = recordMutation(w, op, target, ifMatch, outcome)
      return settleWhenAnswered(w, call, w.s.schedule(apply(...args), op))
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
    resolve: vi.fn((uri: string) => {
      const produce = async () => {
        const current = node(uri.replace('gfs://main/', ''))
        if (!current) throw new Error(failures.notFound)
        const overrides = { parentResourceId: current.parent, version: current.version }
        return resolveResource(
          current.kind === 'directory'
            ? resolvedDirectory(current.id, current.name, overrides)
            : resolvedFile(current.id, current.name, overrides)
        )
      }
      if (uri !== QUARTER_URI) return produce()
      // The Files location's own read is ordered by the scheduler, so two
      // reads of it can actually overlap and K1 can see it.
      const record = { start: tick(w), end: null as number | null }
      w.qReads.push(record)
      const read = w.s.schedule(produce(), 'resolve-location').finally(() => {
        record.end = tick(w)
      })
      // The watch echo of the host's own write, landing while Q is re-read.
      const echo = w.echoOnQRead
      w.echoOnQRead = null
      if (echo) w.watch.deliver(echo)
      return read
    }),
    affordances: (id: string, drive?: string) => {
      w.affordanceCalls += 1
      // A read the run holds back by hand, outside the scheduler's choice.
      const held = w.heldBits.get(id)
      if (held) return held.then(() => affordanceProducer(id, drive))
      return w.s.schedule(affordanceProducer(id, drive), 'affordances')
    },
    listGrants: vi.fn(async (resourceId: string) => {
      const grantId = w.grants.get(resourceId)
      return grantsListPage(
        grantId
          ? [
              {
                id: grantId,
                drive: 'main',
                resourceId,
                subject: AGENT_SUBJECT,
                permissions: ['read'],
                inherit: true,
              },
            ]
          : []
      )
    }),
    revokeGrant: mutation(
      'revokeGrant',
      (grantId: string) => ({
        target: [...w.grants].find(([, id]) => id === grantId)?.[0] ?? grantId,
      }),
      async (grantId: string) => {
        for (const [resourceId, id] of w.grants) if (id === grantId) w.grants.delete(resourceId)
        return revokeGrantReceipt(grantId)
      }
    ),
    download: scheduled(w, 'download', async (uri: string) => {
      const current = node(uri.replace('gfs://main/', ''))
      if (!current) throw new Error(failures.notFound)
      return downloadResult(
        resolvedFile(current.id, current.name, {
          parentResourceId: current.parent,
          version: current.version,
        })
      )
    }),
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
      (parent: string, name: string) => ({ target: parent, outcome: `Uploaded ${name}` }),
      async (parent: string, name: string) => {
        if (!node(parent)) throw new Error(failures.notFound)
        if (nameTaken(parent, name)) throw new Error(failures.conflict)
        const id = newId(w)
        w.nodes.set(id, { id, name, kind: 'file', parent, version: 1, held: ALL_BITS })
        return uploadReceipt(
          parent,
          name,
          childView(id, name, 'file', { parentResourceId: parent })
        )
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
        if (w.changeBeforeNextMove === id) {
          w.changeBeforeNextMove = null
          const changed = node(id)
          if (changed) changed.version += 1
        }
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
          const record = (generation: number) => {
            w.genCalls.push({
              at: tick(w),
              answer: generation,
              host: askedByHost(stack),
              family: askingFamily(stack),
            })
            // Recorded here, with a real call's stack, so the oracle reads it
            // exactly as it reads that call: a check asked from the test itself
            // would not count as the host's and would vanish unnoticed.
            const extra = w.extraGenCheck?.(stack) ?? null
            if (extra !== null) {
              w.genCalls.push({
                at: tick(w),
                answer: generation,
                host: askedByHost(extra),
                family: askingFamily(extra),
              })
            }
          }
          const answer = scheduled(w, 'getSessionGeneration', async () => {
            const generation = w.model.mainGen
            record(generation)
            if (askingFamily(stack) === 'move') {
              w.moveChecksSeen += 1
              // A fixed example revokes access right as the Move asks main.
              if (w.moveChecksSeen === w.revokeAtMoveCheck) {
                const live = w.model.session
                w.access.push({ at: tick(w), session: sessionKey(live), kind: 'revoke' })
                revokeGfsSessionAccess(w.queryClient, scopeOf(live.team), live.gen)
              }
            }
            return generation
          })
          let stack: string | undefined
          return () => {
            stack = new Error().stack
            const held = w.heldGen
            if (!held) return answer()
            // Main answers now; the renderer receives it when the example says.
            w.heldGen = null
            const generation = w.model.mainGen
            record(generation)
            return held.promise.then(() => generation)
          }
        })(),
      },
      gfs,
      gfsWatch: w.watch.bridge,
      sandboxUi,
      team: { directory: vi.fn(async () => ({ items: [] })) },
      agents: { listMine: vi.fn(async () => structuredClone(myAgents)) },
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
    world.triggers.push({ at: world.clock, mutation: false })
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

/**
 * App's seam around the sidebar actions, reduced to the parts they touch.
 * Copied from App.tsx (watch routing, Files location key, overlay gate);
 * App.sidebarGfsMenu.test.tsx and App.gfsWatch.test.tsx cover that seam in
 * the real App, so a drift there fails those suites, not this one.
 */
function Composition({ world, session }: { world: World; session: Session }) {
  const queryClient = useQueryClient()
  const ui = useSyncExternalStore(world.ui.subscribe, world.ui.get)
  const scope = scopeOf(session.team)
  const authorityRef = useRef({ scope, generation: session.gen })
  authorityRef.current = { scope, generation: session.gen }
  const overlay = useGfsActionOverlay(true)
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
  useEffect(() => {
    world.renderedKeys = JSON.stringify(keys)
  }, [keys, world])
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
// Far below the test timeout, so a run that never settles fails here, with
// its own message, instead of being cut by the timeout.
const REST_DEADLINE_MS = 20_000

async function rest(w: World, { awaitWatchDebounce = true } = {}) {
  const deadline = performance.now() + REST_DEADLINE_MS
  for (let pass = 0; pass < 2000 && performance.now() < deadline; pass += 1) {
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
    if (w.s.count() > 0) continue
    // A change of watched keys reaches main only after the watch debounce:
    // at rest, main holds the keys the composition renders.
    const sentKeys = JSON.stringify(w.watch.requests.at(-1)?.keys ?? [])
    if (awaitWatchDebounce && sentKeys !== w.renderedKeys) {
      await act(async () => {
        await sleep(GFS_WATCH_DEBOUNCE_MS / 3)
      })
      continue
    }
    return
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

/** Inert: `aria-disabled` (with or without a reason), or natively disabled. */
function isInert(item: HTMLButtonElement): boolean {
  return item.disabled || item.getAttribute('aria-disabled') === 'true'
}

/**
 * The menu still waits on the target's bits: an item is inert although the
 * bits the target holds allow it. An item its bits refuse stays inert for good.
 */
function awaitingBits(w: World, menu: HTMLElement): boolean {
  const node = w.model.menu ? w.nodes.get(w.model.menu.target) : undefined
  return (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).some(item => {
    if (!isInert(item)) return false
    const label = item.textContent?.trim() ?? ''
    if (label === 'Move to') {
      const parent = node?.parent ? w.nodes.get(node.parent) : undefined
      // Move needs write and delete on the exact old parent.
      return Boolean(parent?.held.includes('write') && parent.held.includes('delete'))
    }
    const bit = ACTION_BITS[label]
    return !bit || !node || node.held.includes(bit)
  })
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
    if (bit && !isInert(item) && node && !node.held.includes(bit)) {
      out.push(`H1/H2: ${item.textContent} is enabled on ${node.name}, which lacks ${bit}`)
    }
  }
  return out
}

function checkAtRest(w: World) {
  expect(atRestViolations(w)).toEqual([])
}

/** Every invariant broken at rest, as one message each. */
function atRestViolations(w: World): string[] {
  // A generation answer a fixed example still holds: an outcome is pending,
  // so L1 cannot be judged yet. Held bit reads and a held publish leave the
  // composition at rest (a pending menu, a renderer behind main) and are checked.
  if (w.heldGen || w.releaseGen) return [...w.violations]
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
    // A Move becomes `running` only after its first generation check, and a
    // Share write only starts while its dialog is mounted: a close that really
    // took effect before the request cancels it, which is accepted. A close
    // ignored while running does not count.
    if (
      (submission.op === 'moveResource' || submission.op === 'revokeGrant') &&
      submission.calls.length === 0 &&
      (submission.dismissedAt ?? -1) > submission.at
    ) {
      continue
    }
    // A submit may stop before the IPC (a re-check found the resource changed),
    // but never silently: its own toast, or an error banner in its own dialog.
    noteInlineErrors(w)
    if (!submission.toasted && !submission.shownInline) {
      violations.push(
        `L1: ${submission.op} on ${submission.target} ended with nothing visible (${submission.calls.length} sent)`
      )
    }
  }
  // K1, per submission and without lending: each host check is charged to
  // the submission that asked, found by the kind of action on its stack and
  // the latest activity of that kind before it. Its bound is exact for the
  // route it took: one per operation and one before the outcome, or, for a
  // Move, the measured count of the pipeline path it ended on. Uploads are
  // bounded apart, below: they are the one action that runs outside the
  // host's dialog, so two of them can interleave and the latest activity no
  // longer names the one that asked.
  const routeBudget = (s: Submission) => {
    if (s.op !== 'moveResource') return s.calls.length + 1
    const call = s.calls[0]
    if (!call) return s.refusedAsChanged ? MOVE_REFUSED_CHECKS : MOVE_UNSENT_CHECKS
    return call.rejected ? MOVE_VERIFIED_CHECKS : MOVE_COMMITTED_CHECKS
  }
  const charged = new Map<Submission, number>()
  const lastActivityBefore = (s: Submission, at: number) =>
    Math.max(
      ...[s.at, ...s.calls.flatMap(call => [call.at, call.settledAt ?? -1])].filter(t => t < at),
      -1
    )
  // A copy or a download is no submission: it asks main once, before its toast.
  const gestureChecks = w.genCalls.filter(call => call.host && call.family === 'gesture').length
  if (gestureChecks > w.openings.length) {
    violations.push(
      `K1: ${gestureChecks} copy/download generation checks for ${w.openings.length} gestures`
    )
  }
  const perSubmission = w.genCalls.filter(
    call => call.host && call.family !== 'gesture' && call.family !== 'upload'
  )
  for (const check of perSubmission) {
    const asker = w.submissions
      .filter(s => familyOf(s.op) === check.family && s.at < check.at)
      .sort((a, b) => lastActivityBefore(b, check.at) - lastActivityBefore(a, check.at))[0]
    if (!asker) {
      violations.push(`K1: a ${check.family} generation check at ${check.at} has no submission`)
      continue
    }
    charged.set(asker, (charged.get(asker) ?? 0) + 1)
  }
  for (const [s, count] of charged) {
    if (count > routeBudget(s)) {
      violations.push(
        `K1: ${s.op} #${s.id} asked main ${count} times for a bound of ${routeBudget(s)}`
      )
    }
  }
  violations.push(...uploadCheckViolations(w))

  // K1 for the location on screen: after a mutation lands, the background
  // re-reads of Q it causes (the host's refresh, the watch echo) are at most
  // two and never overlap. The window closes at the next event that re-reads
  // Q for its own reasons (a Files mount, a remote change, a session change).
  const triggers = [...w.triggers].sort((a, b) => a.at - b.at)
  triggers.forEach((trigger, index) => {
    if (!trigger.mutation) return
    const end = triggers[index + 1]?.at ?? Infinity
    const reads = w.qReads.filter(read => read.start > trigger.at && read.start < end)
    if (reads.length > 2) {
      violations.push(`K1: ${reads.length} reads of the Files location after one mutation`)
    }
    const overlapping = reads.some(read =>
      reads.some(
        other => other !== read && other.start > read.start && other.start < (read.end ?? Infinity)
      )
    )
    if (overlapping) violations.push('K1: 2 reads of the Files location at once after one mutation')
  })
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
    // Gone from the server: the existing inaccessible state, not stale crumbs.
    // A background refresh says the location is no longer available; a fresh
    // mount that cannot open it shows its read error.
    const filesError = Array.from(document.querySelectorAll('.status-banner.tone-error')).some(
      banner => !banner.closest('.da-file-explorer, [role="dialog"], [role="alertdialog"]')
    )
    const unavailable = Boolean(screen.queryByText(GFS_UNAVAILABLE_LOCATION_MESSAGE)) || filesError
    if (!expected && (shown.length > 0 || !unavailable)) {
      violations.push(
        `L2: Files shows ${JSON.stringify(shown)} for a location that no longer exists`
      )
    }
  }

  // S4: an outcome is only shown in the session it belongs to.
  for (const toast of w.toasts) {
    if (toast.legal === false) {
      violations.push(`S4: "${toast.message}" ${toast.why ?? ''}`)
    }
  }

  return violations
}

/**
 * K1 for uploads. A check carries no identity of the upload that asked, and
 * two uploads in flight ask in any order (an earlier one may still wait on
 * its write check while a later one finishes). So each check is charged to
 * the uploads live when it was asked: opened before it and not yet past the
 * toast attributed to them. When several are live they are joined, and a
 * group is held to the sum of its members' bounds; an upload that never
 * shares a check with another stays held to its own.
 *
 * An upload with no toast (aborted, refused, its picker closed) stays live
 * until rest, so every later upload joins it, and any bound it left unused
 * can hide an extra check of theirs. That only loosens the bound, it never
 * charges an upload for a check it did not ask: the one that asked is always
 * live, since its own toast comes after its last check. A newer upload with
 * the same outcome text may take that toast instead, but then the one that
 * asked has none and stays live, and the two were already joined when the
 * newer one asked before its request.
 */
function uploadCheckViolations(w: World): string[] {
  const violations: string[] = []
  const uploads = w.submissions.filter(s => s.op === 'createFileFromPath')
  const liveAt = (s: Submission, at: number) =>
    s.at < at && (s.toastedAt === null || s.toastedAt > at)
  const parent = new Map(uploads.map(s => [s, s]))
  const root = (s: Submission): Submission => {
    let r = s
    while (parent.get(r) !== r) r = parent.get(r)!
    return r
  }
  const charged = new Map<Submission, number>()
  for (const check of w.genCalls.filter(call => call.host && call.family === 'upload')) {
    const live = uploads.filter(s => liveAt(s, check.at))
    const first = live[0]
    if (!first) {
      violations.push(`K1: an upload generation check at ${check.at} has no live upload`)
      continue
    }
    for (const other of live.slice(1)) parent.set(root(other), root(first))
    charged.set(first, (charged.get(first) ?? 0) + 1)
  }
  const groups = new Map<Submission, Submission[]>()
  for (const s of uploads) groups.set(root(s), [...(groups.get(root(s)) ?? []), s])
  for (const members of groups.values()) {
    const asked = members.reduce((sum, s) => sum + (charged.get(s) ?? 0), 0)
    const bound = members.reduce((sum, s) => sum + s.calls.length + 1, 0)
    if (asked <= bound) continue
    const only = members.length === 1 ? members[0] : undefined
    violations.push(
      only
        ? `K1: ${only.op} #${only.id} asked main ${asked} times for a bound of ${bound}`
        : `K1: uploads ${members.map(s => `#${s.id}`).join(',')} asked main ${asked} times for a bound of ${bound}`
    )
  }
  return violations
}

const COPY_LINK_TOASTS = /^Shareable EvenDrive link|^Shareable EvenDrive links are unavailable/

/** Whether `message` is one of the toasts the gesture can end with. */
function isGestureOutcome(gesture: Gesture, message: string): boolean {
  if (gesture.actionId === 'copy-link') return COPY_LINK_TOASTS.test(message)
  return (
    message === `Downloaded ${gesture.name}` ||
    message === describeGfsReadError(new Error(failures.notFound)).message
  )
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A Move outcome toast for `name`, in one of the forms the commit pipeline writes. */
function isMoveToastFor(name: string, message: string): boolean {
  const source = escapeRegExp(name)
  return (
    new RegExp(`^Moved ${source} to .+$`).test(message) ||
    new RegExp(`^${source} → .+: .+$`).test(message)
  )
}

/**
 * S4, judged when the toast is pushed. Each toast is attributed to the
 * submission whose outcome it is (its success text, or the rejection its own
 * request got), and only that submission's session decides: it must be the
 * rendered one, active, and still main's unless a host check answered it
 * before main moved on.
 */
function judgeToast(w: World, toast: Toast) {
  const live = w.model.session
  const current = (origin: Session) => sameSession(origin, live) && accessActive(w, live)
  // The server's rejections read the same for every request: one is only
  // another submission's if it ran in the session the toast is shown in.
  const shared = Object.values(failures).includes(toast.message)
  const source = [...w.submissions]
    .reverse()
    .find(
      s =>
        (!shared || sameSession(s.origin, toast.session)) &&
        (s.outcomes.has(toast.message) ||
          (s.op === 'moveResource' && isMoveToastFor(s.name, toast.message)))
    )
  if (source) {
    source.toasted = true
    source.toastedAt = toast.at
    toast.legal =
      current(source.origin) &&
      mainAdmits(w, source.origin.gen, source.calls.at(-1)?.at ?? source.at)
    if (!toast.legal) {
      toast.why = `belongs to ${source.op} #${source.id} of ${sessionKey(source.origin)}, shown in ${sessionKey(live)} with main at ${w.model.mainGen}`
    }
    return
  }
  // A copy or a download opens no dialog, but its toast is an outcome like
  // any other: the session it was chosen in must still be the rendered one and main's.
  const gestures = w.openings.filter(o => isGestureOutcome(o, toast.message))
  if (gestures.length > 0) {
    toast.legal = gestures.some(o => current(o.origin) && mainAdmits(w, o.origin.gen, o.at))
    if (!toast.legal) {
      toast.why = `${gestures[0]!.actionId} feedback outside the session it was chosen in`
    }
    return
  }
  toast.legal = false
  toast.why = "is no submission's outcome"
}

// ── Commands: the A2 events ─────────────────────────────────────────────────

/** What the runs actually reached, so a vacuous pass shows up. */
const coverage = new Map<string, number>()
/** The same, for generated runs only: fixed examples reach their paths by construction. */
const generatedCoverage = new Map<string, number>()
let runIsExample = false
const cover = (what: string) => {
  coverage.set(what, (coverage.get(what) ?? 0) + 1)
  if (!runIsExample) generatedCoverage.set(what, (generatedCoverage.get(what) ?? 0) + 1)
}

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
    noteInlineErrors(w)
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
    const dialogBefore = hostDialogs().length > 0
    fireEvent.keyDown(menu, { key: 'Escape' })
    m.menu = null
    await flush()
    // A host dialog that opened under a menu still on screen may hear the
    // same Escape: both outcomes are accepted, and the model follows the one
    // that happened.
    if (dialogBefore && hostDialogs().length === 0 && m.action) dismissed(w, m.action)
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
  download: 'Download',
}
const labelOf = (actionId: string): string => ACTION_LABELS[actionId]!
const inShareFlyout = (actionId: string) => actionId === 'share' || actionId === 'copy-link'

/** E4: choose an item of the open menu. */
class Choose extends OracleEvent {
  constructor(readonly actionId: string) {
    super()
  }
  async perform(m: Model, w: World) {
    const menu = openMenu()
    if (!menu || !m.menu) return
    const label = labelOf(this.actionId)
    let item = within(menu).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null
    const copy = inShareFlyout(this.actionId) && this.actionId !== 'share'
    if (!item?.getAttribute('aria-haspopup') && copy) item = null
    if (inShareFlyout(this.actionId)) {
      // Share and the copies live in the Share flyout once it has entries of its own.
      const trigger = (within(menu).queryAllByRole('menuitem') as HTMLButtonElement[]).find(entry =>
        entry.getAttribute('aria-haspopup')
      )
      if (trigger && !isInert(trigger)) {
        fireEvent.click(trigger)
        await flush()
        const flyout = screen.queryByRole('menu', { name: /^Share options for / })
        item = flyout
          ? (within(flyout).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null)
          : null
      } else if (copy) {
        item = within(menu).queryByRole('menuitem', { name: label }) as HTMLButtonElement | null
      }
    }
    if (!item || isInert(item)) return
    const settled = !awaitingBits(w, menu)
    const opened = m.menu
    const at = tick(w)
    const live = sameSession(opened.origin, m.session) && accessActive(w, m.session)
    // A copy or a download opens no action: its toast is judged against the opening itself.
    const gesture = GESTURES.has(this.actionId)
    if (live && gesture) {
      w.openings.push({
        actionId: this.actionId as GestureId,
        name: opened.name,
        origin: opened.origin,
        at,
      })
    }
    if (live && !gesture) {
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

/** The notice a committed folder Move adds to its success toast. */
const FOLDER_MOVE_NOTICE =
  'Moving a folder changes who can access its contents — access now follows the new location.'

function submit(
  m: Model,
  w: World,
  op: MutationOp,
  action: ModelAction,
  outcome?: string
): Submission {
  // The host names the resource as the row showed it when the action was chosen.
  const submission: Submission = {
    name: action.targetName,
    outcomes: new Set(outcome ? [outcome] : []),
    toasted: false,
    toastedAt: null,
    shownInline: false,
    refusedAsChanged: false,
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
      const value = rename ? `${current.replace(/-r\d+$/, '')}-r${this.n}` : `Folder ${this.n}`
      fireEvent.change(input, { target: { value } })
      const save = button(rename ? 'Save' : 'Create folder')
      if (!save || save.disabled) return
      submit(
        m,
        w,
        rename ? 'renameResource' : 'createFolder',
        action,
        rename ? `Renamed to ${value}` : `Folder ${value} created`
      )
      fireEvent.click(save)
    } else if (action.actionId === 'delete') {
      const confirm = button('Delete')
      if (!confirm || confirm.disabled) return
      submit(m, w, 'deleteResource', action, `Deleted ${action.targetName}`)
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
      const moved = submit(m, w, 'moveResource', action)
      moved.outcomes.add(FOLDER_MOVE_NOTICE)
      fireEvent.click(move)
    } else if (action.actionId === 'share') {
      // Only a root carries a grant of its own; elsewhere the row is inherited.
      if (w.nodes.get(action.target)?.parent !== null || !w.grants.has(action.target)) return
      const rowActions = `Actions for ${AGENT_NAME}`
      // The access list comes from reads the scheduler does not hold back.
      let rowMenu = button(rowActions)
      for (let wait = 0; wait < 6 && !rowMenu; wait += 1) {
        await act(async () => {
          await sleep(10)
        })
        rowMenu = button(rowActions)
      }
      if (!rowMenu || rowMenu.disabled) return
      fireEvent.click(rowMenu)
      await flush()
      const remove = screen.queryByRole('menuitem', {
        name: 'Remove access',
      }) as HTMLButtonElement | null
      if (!remove || remove.disabled) return
      submit(m, w, 'revokeGrant', action, `Access revoked for ${AGENT_NAME}`)
      fireEvent.click(remove)
    } else {
      return
    }
    await flush()
  }
  toString() {
    return `Submit(${this.n})`
  }
}

/**
 * An error banner in the open dialog is the outcome of that action's latest
 * submit (L1), even if the user closes the dialog afterwards.
 */
function noteInlineErrors(w: World) {
  const action = w.model.action
  if (!action) return
  const banners = hostDialogs().flatMap(dialog =>
    Array.from(dialog.querySelectorAll('.status-banner.tone-error'))
  )
  if (banners.length === 0) return
  const latest = w.submissions.filter(s => s.actionToken === action.token).at(-1)
  if (!latest) return
  latest.shownInline = true
  if (banners.some(banner => /changed while you were moving it/.test(banner.textContent ?? ''))) {
    latest.refusedAsChanged = true
  }
}

/** The action's dialog really closed on the user's request. */
function dismissed(w: World, action: ModelAction) {
  action.dismissedAt ??= tick(w)
  for (const s of w.submissions) {
    if (s.actionToken === action.token && s.dismissedAt === null) s.dismissedAt = action.dismissedAt
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
    // Only the host's `running` phase locks the close. Share writes run inside
    // its own dialog, which may close mid-write: the outcome is still reported
    // (L1) and still gated by session (S4).
    const running =
      action !== null &&
      w.submissions.some(
        s =>
          s.actionToken === action.token &&
          familyOf(s.op) !== 'share' &&
          s.calls.some(call => !call.settled)
      )
    const closeEnabled = !(close as HTMLButtonElement).disabled
    if (action) action.dismissedAt = tick(w)
    fireEvent.click(close)
    await flush()
    if (action && hostDialogs().length === 0) dismissed(w, action)
    // A mutation cannot be recalled: closing is ignored while it runs.
    if (running && hostDialogs().length === 0) {
      w.violations.push(`H4/H18: closing the ${action!.actionId} dialog took effect while it ran`)
    }
    // Share may close mid-write, so an enabled Close that leaves it open is a lie.
    if (action?.actionId === 'share' && closeEnabled && hostDialogs().length !== 0) {
      w.violations.push('L1: the enabled Close of the share dialog left it open')
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
    w.triggers.push({ at: w.clock, mutation: false })
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
    w.triggers.push({ at: w.clock, mutation: false })
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
    w.triggers.push({ at: w.clock, mutation: false })
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
    await remoteChange(w, node)
  }
  toString() {
    return `RemoteChange(${this.pick})`
  }
}

/** Another client writes `node`; the watch reports its folder changed. */
async function remoteChange(w: World, node: ServerNode) {
  node.version += 1
  w.triggers.push({ at: tick(w), mutation: false })
  const events = changedEvents.get(node.parent!)
  if (!events) return
  await act(async () => {
    w.watch.deliver(events)
  })
}

/** E10: the Files tab is left or re-entered (it remounts on its saved route). */
class ToggleFilesTab extends OracleEvent {
  async perform(m: Model, w: World) {
    if (m.pickerOpen) return
    m.filesTab.active = !m.filesTab.active
    if (m.filesTab.active) {
      m.filesTab.route = w.locations.length > 0 ? (w.locations.at(-1) ?? null) : QUARTER_URI
      m.filesTab.mountedAt = tick(w)
      w.triggers.push({ at: w.clock, mutation: false })
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
        else if (sent) await new Step().perform(m, w)
        else {
          // A Move checks the session around each step before its request
          // goes out: waiting covers several answers, not one per gesture.
          for (let answer = 0; answer < 3 && w.s.count() > 0; answer += 1) {
            await new Step().perform(m, w)
          }
        }
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
      if (awaitingBits(w, menu) && w.s.count() > 0) {
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
            item => !isInert(item) && item.textContent?.trim() === label
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
  // At rest with the menu still waiting for its bits: it covers the view (S6).
  new Rest(),
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

/**
 * A Share removal whose request is out when main switches session: its
 * outcome belongs to the session it ran in, never the next one (S4).
 */
const shareOutcomeAfterSwitch = (): Cmd[] => [
  new OpenMenuOn('Docs'),
  new Rest(),
  new Choose('share'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('revokeGrant'),
  new SwitchTeam(),
  new Rest(),
]

/**
 * Closing the Share dialog while its removal is in flight is allowed: Share
 * never enters the host's `running` phase. The outcome is still owed (L1).
 */
const closeDuringShareRemoval = (): Cmd[] => [
  new OpenMenuOn('Docs'),
  new Rest(),
  new Choose('share'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('revokeGrant'),
  new DismissDialog(),
  new Rest(),
]

/** The same close, then main switches session: the late outcome is not shown (S4). */
const shareOutcomeAfterCloseAndSwitch = (): Cmd[] => [
  new OpenMenuOn('Docs'),
  new Rest(),
  new Choose('share'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('revokeGrant'),
  new DismissDialog(),
  new SwitchTeam(),
  new Rest(),
]

/** A download whose bytes arrive after main switched session shows nothing (S4). */
const downloadAfterSwitch = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('download'),
  new SwitchTeam(),
  new Rest(),
]

/** Lets everything land without judging: a held read keeps an outcome pending. */
class Settle extends OracleEvent {
  async perform(_m: Model, w: World) {
    await rest(w)
  }
  toString() {
    return 'Settle'
  }
}

/**
 * An action chosen while another one's opening check is still out replaces
 * it; the replaced check, landing later, must leave the new dialog alone (L1).
 */
const choiceReplacesOpeningCheck = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  // Stale bits make the opening read them again; that read is held.
  new BitsAge(),
  new HoldBits(NOTES),
  new Choose('rename'),
  new OpenMenuOn('Quarterly'),
  new Settle(),
  new Choose('delete'),
  new Rest(),
  new ReleaseBits(NOTES),
  new Rest(),
]

/** Expands a named folder of the tree. */
class ExpandOn extends OracleEvent {
  constructor(readonly name: string) {
    super()
  }
  async perform(_m: Model, _w: World) {
    const toggle = screen.queryByRole('button', { name: `Expand ${this.name}` })
    if (!toggle) return
    fireEvent.click(toggle)
    await flush()
  }
  toString() {
    return `ExpandOn(${this.name})`
  }
}

/** The watch's `changed` for Q arrives while the next read of Q is in flight. */
class EchoOnNextQRead extends OracleEvent {
  async perform(_m: Model, w: World) {
    w.echoOnQRead = changedEvents.get(QUARTER) ?? null
  }
  toString() {
    return 'EchoOnNextQRead'
  }
}

/** E9 on a named resource. */
class RemoteChangeOn extends OracleEvent {
  constructor(readonly resourceId: string) {
    super()
  }
  async perform(_m: Model, w: World) {
    const node = w.nodes.get(this.resourceId)
    if (node) await remoteChange(w, node)
  }
  toString() {
    return `RemoteChangeOn(${this.resourceId.slice(0, 4)})`
  }
}

/** Main answers the next generation check now; the renderer receives it on `ReleaseGen`. */
class HoldNextGen extends OracleEvent {
  async perform(_m: Model, w: World) {
    let release!: () => void
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    w.heldGen = { promise, release }
    w.releaseGen = release
  }
  toString() {
    return 'HoldNextGen'
  }
}

class ReleaseGen extends OracleEvent {
  async perform(_m: Model, w: World) {
    const release = w.releaseGen
    w.releaseGen = null
    await act(async () => {
      release?.()
      await sleep(10)
    })
  }
  toString() {
    return 'ReleaseGen'
  }
}

/** T4 for the Move CAS: no PATCH went out and its dialog shows the refusal. */
class ExpectMoveRefused extends OracleEvent {
  async perform(_m: Model, w: World) {
    if (w.calls.some(call => call.op === 'moveResource')) {
      w.violations.push('S5: a Move of a resource changed since it was chosen was sent')
    }
    const refused = hostDialogs().some(dialog =>
      /changed while you were moving it/.test(dialog.textContent ?? '')
    )
    if (!refused) w.violations.push('S5/L1: the refused Move shows no error in its dialog')
  }
  toString() {
    return 'ExpectMoveRefused'
  }
}

/**
 * Main's answer to the host's last check, given under the origin session,
 * arrives after the renderer published a switch away and back to the same
 * team: same scope, newer generation (S4).
 */
const staleAnswerAfterRoundTrip = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('rename'),
  new Rest(),
  new Submit(1),
  new StepUntilSent('renameResource'),
  new HoldNextGen(),
  new Rest(),
  new SwitchTeam(false),
  new PublishHeldSession(),
  new Rest(),
  new SwitchTeam(false),
  new PublishHeldSession(),
  new Rest(),
  new ReleaseGen(),
  new Rest(),
]

/** The row changes on the server between choosing Move and submitting it (S5, H7). */
const moveAfterRemoteChange = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new RemoteChangeOn(NOTES),
  new Rest(),
  new Submit(1),
  new Rest(),
  new ExpectMoveRefused(),
]

/**
 * A rename inside Q: the host re-reads Q and the watch echo of the same write
 * lands during that read. The keyed single flight keeps the reads sequential (K1).
 */
const echoDuringHostRefresh = (): Cmd[] => [
  new ExpandOn('Quarterly'),
  new Rest(),
  new OpenMenuOn('chart.png'),
  new Rest(),
  new Choose('rename'),
  new Rest(),
  new EchoOnNextQRead(),
  new Submit(1),
  new Rest(),
]

/** Revokes access while the Move asks main for the `n`-th time. */
class RevokeAtMoveCheck extends OracleEvent {
  constructor(readonly n: number) {
    super()
  }
  async perform(_m: Model, w: World) {
    w.revokeAtMoveCheck = w.moveChecksSeen + this.n
  }
  toString() {
    return `RevokeAtMoveCheck(${this.n})`
  }
}

/** A Move that passes every pre-dispatch check and loses access right before its PATCH. */
const moveLostBeforeDispatch = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new RevokeAtMoveCheck(4),
  new Submit(1),
  new Rest(),
]

/** Another client writes `resourceId` just before the next Move PATCH of it arrives. */
class ChangedBeforePatch extends OracleEvent {
  constructor(readonly resourceId: string) {
    super()
  }
  async perform(_m: Model, w: World) {
    w.changeBeforeNextMove = this.resourceId
  }
  toString() {
    return `ChangedBeforePatch(${this.resourceId.slice(0, 4)})`
  }
}

/**
 * A Move whose PATCH meets a version the server changed after the pipeline
 * resolved the source: the pipeline verifies by identity afterwards, its
 * longest path.
 */
const moveVerifiedAfterRejection = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new ChangedBeforePatch(NOTES),
  new Submit(1),
  new Rest(),
]

/**
 * A committed Move, then a rename: each is held to its own bound, so the
 * Move's unused checks never cover an extra one in the rename (K1).
 */
const moveThenRename = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('move'),
  new Rest(),
  new Submit(1),
  new Rest(),
  new OpenMenuOn('readme.md'),
  new Rest(),
  new OpenMenuOn('Quarterly'),
  new Rest(),
  new Choose('rename'),
  new Rest(),
  new Submit(2),
  new Rest(),
]

/** A delete and a new folder, so the fixed examples alone reach the operations floor. */
const deleteThenNewFolder = (): Cmd[] => [
  new OpenMenuOn('notes.txt'),
  new Rest(),
  new Choose('delete'),
  new Rest(),
  new Submit(1),
  new Rest(),
  new OpenMenuOn('Quarterly'),
  new Rest(),
  new Choose('new-folder'),
  new Rest(),
  new Submit(2),
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
 * per operation. These are measured counts per pipeline path, pinned as a
 * regression check, not invariants derived from the spec: the test below
 * fails when any of them changes, and the numbers are then re-measured, not
 * reasoned about. A committed Move's count includes the host's outcome check.
 */
const MOVE_COMMITTED_CHECKS = 9
/** A PATCH rejected and verified by identity afterwards, the longest path. */
const MOVE_VERIFIED_CHECKS = 10
/** No PATCH sent: the source changed since it was chosen and the Move is refused. */
const MOVE_REFUSED_CHECKS = 5
/**
 * No PATCH sent for any other reason: the longest such path passes every
 * pre-dispatch check and loses the session right before the PATCH.
 */
const MOVE_UNSENT_CHECKS = 6

/** Lets answers land one by one until the host asked main `count` times for `family`. */
class StepUntilChecks extends OracleEvent {
  constructor(
    readonly family: ActionFamily,
    readonly count: number
  ) {
    super()
  }
  async perform(m: Model, w: World) {
    const asked = () => w.genCalls.filter(call => call.host && call.family === this.family).length
    for (let step = 0; step < 50 && asked() < this.count; step += 1) {
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
    return `StepUntilChecks(${this.family},${this.count})`
  }
}

/** The next upload generation check is recorded twice, as an upload asking once too often would. */
class DuplicateNextUploadCheck extends OracleEvent {
  async perform(_m: Model, w: World) {
    w.extraGenCheck = stack => {
      if (askingFamily(stack) !== 'upload') return null
      w.extraGenCheck = null
      return stack ?? ''
    }
  }
  toString() {
    return 'DuplicateNextUploadCheck'
  }
}

/**
 * Keeps the stack of the next upload generation check and records one more
 * check under it during the next copy or download, when that upload is over.
 */
class UploadCheckOnNextGesture extends OracleEvent {
  async perform(_m: Model, w: World) {
    let upload: string | null = null
    w.extraGenCheck = stack => {
      const family = askingFamily(stack)
      if (family === 'upload') upload ??= stack ?? ''
      if (family !== 'gesture' || upload === null) return null
      w.extraGenCheck = null
      return upload
    }
  }
  toString() {
    return 'UploadCheckOnNextGesture'
  }
}

/** One upload of `file` into `folder`, carried to its outcome. */
const uploadTo = (folder: string, file: string): Cmd[] => [
  new OpenMenuOn(folder),
  new Settle(),
  new Choose('upload-file'),
  new Settle(),
  new Pick(file),
  new Settle(),
]

/**
 * An upload that ends with no toast and no generation check: access is
 * revoked while the picker is open, so the host drops the chosen file unread.
 * Access then comes back for what follows.
 */
const droppedUpload = (folder: string): Cmd[] => [
  new OpenMenuOn(folder),
  new Settle(),
  new Choose('upload-file'),
  new Settle(),
  new Revoke(),
  new Pick('report.txt'),
  new Settle(),
  new RetryAccess(),
  new Settle(),
]

/**
 * Two uploads in flight at once: the first one's write check waits on a bit
 * read while the second runs to its outcome, so the first asks main for the
 * generation after the second's request already landed. Each upload asks
 * main exactly twice (before its request, before its outcome).
 */
const crossedUploads = (): Cmd[] => [
  new OpenMenuOn('Quarterly'),
  new Settle(),
  new Choose('upload-file'),
  new Settle(),
  new BitsAge(),
  new HoldBits(QUARTER),
  new Pick('notes.txt'),
  new Settle(),
  new OpenMenuOn('Docs'),
  new Settle(),
  new Choose('upload-file'),
  new Settle(),
  new Pick('report.txt'),
  new Settle(),
  new ReleaseBits(QUARTER),
  new Settle(),
]

/** Runs a fixed example to rest under the example scheduler, then judges it. */
async function atRestAfter(commands: Cmd[], judge: (w: World) => void) {
  const w = await mountWorld(exampleScheduler())
  try {
    await fc.asyncModelRun(() => ({ model: w.model, real: w }), commands)
    await rest(w)
    judge(w)
  } finally {
    await unmountWorld(w)
  }
}

const uploadChecks = (w: World) => w.genCalls.filter(call => call.host && call.family === 'upload')
const uploadsOf = (w: World) => w.submissions.filter(s => s.op === 'createFileFromPath')

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
      'move',
      'move',
      'new-folder',
      'upload-file',
      'share',
      'share',
      'copy-link',
      'download'
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
    grants: new Map([
      [DOCS, '42424242-4242-4242-4242-424242424242'],
      [ARCHIVE, '43434343-4343-4343-4343-434343434343'],
    ]),
    heldGen: null,
    extraGenCheck: null,
    changeBeforeNextMove: null,
    revokeAtMoveCheck: null,
    moveChecksSeen: 0,
    releaseGen: null,
    qReads: [],
    triggers: [],
    renderedKeys: '[]',
    echoOnQRead: null,
    violations: [],
    watch: watchSource.connectRenderer(),
    embed: createPageEmbed(),
  }
  installBridge(w)
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {
    w.pickerClicks += 1
  })
  // jsdom saves nothing to disk: the download's anchor click is inert.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
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
    await rest(w, { awaitWatchDebounce: false })
  }
  fireEvent.click(screen.getByRole('button', { name: 'Expand Docs' }))
  for (let pass = 0; pass < 20 && treeRows(w).length < 5; pass += 1) {
    await rest(w, { awaitWatchDebounce: false })
  }
  // Only the last setup pass waits for the watch to send its keys to main.
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
  const casRefusal = /changed since it was read|changed while you were moving it/
  if (
    w.toasts.some(t => casRefusal.test(t.message)) ||
    hostDialogs().some(d => casRefusal.test(d.textContent ?? ''))
  )
    cover('cas-refused')
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
  // The local file the upload producer reads, as a picked file would be.
  uploadSource = join(mkdtempSync(join(tmpdir(), 'gfs-oracle-')), 'report.txt')
  writeFileSync(uploadSource, 'data')
  myAgents = await myAgentsListing()
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
  // jsdom has no object URLs, which a download saves through.
  URL.createObjectURL = () => 'blob:gfs-oracle'
  URL.revokeObjectURL = () => undefined
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
// Fixed by default so every run of the suite explores the same cases;
// GFS_ACTION_ORACLE_SEED picks another, and `random` opts into a fresh one.
const SEED_SETTING = process.env.GFS_ACTION_ORACLE_SEED ?? '20261119'
const SEED = SEED_SETTING === 'random' ? undefined : Number(SEED_SETTING)
// Shrinking a long command list can outlast the test timeout and lose the
// counterexample: stop in time and report the smallest one found so far.
const PROPERTY_TIME_LIMIT_MS = 240_000

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
        runIsExample = EXAMPLE_RUNS.has(commands)
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
      // fast-check counts the examples inside numRuns: add them so `numRuns`
      // stays the number of generated runs.
      numRuns: numRuns + examples.length,
      seed: SEED,
      endOnFailure: Boolean(process.env.CI),
      interruptAfterTimeLimit: PROPERTY_TIME_LIMIT_MS,
      markInterruptAsFailure: true,
      examples: examples.map(build => {
        const commands = build()
        EXAMPLE_RUNS.add(commands)
        return [exampleScheduler(), commands] as [Scheduler, Iterable<Cmd>]
      }),
    }
  )
}

const EXAMPLE_RUNS = new WeakSet<object>()

describe('GfsActionHost — model-based oracle', () => {
  it('keeps every safety, liveness and cost invariant at rest under generated events and IPC orders', async () => {
    generatedCoverage.clear()
    await checkGenerated(allEvents, RUNS, 36, [
      outcomeWhileMainIsAhead,
      staleAnswerAfterRoundTrip,
      moveAfterRemoteChange,
      echoDuringHostRefresh,
      moveThenRename,
      shareOutcomeAfterSwitch,
      closeDuringShareRemoval,
      shareOutcomeAfterCloseAndSwitch,
      choiceReplacesOpeningCheck,
      downloadAfterSwitch,
      deleteThenNewFolder,
    ])
    // What the generated runs reached is reported, not asserted: it depends
    // on how the draws fall, and any new awaited IPC reorders them. The fixed
    // examples guarantee the paths the floors below need.
    const generatedMoves = generatedCoverage.get('call:moveResource') ?? 0
    process.stdout.write(
      `gfs action oracle coverage (generated): ${JSON.stringify(Object.fromEntries([...generatedCoverage].sort()))}\n`
    )
    if (generatedMoves === 0) {
      process.stdout.write('gfs action oracle: no generated run reached a Move PATCH\n')
    }
    // Guard against a vacuous pass: most operations reached main, a Move was
    // committed, an outcome succeeded and a CAS was refused.
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
    expect(coverage.get('call:moveResource') ?? 0, 'a Move PATCH (example)').toBeGreaterThan(0)
    expect(coverage.get('toast:success') ?? 0).toBeGreaterThan(0)
    expect(coverage.get('cas-refused') ?? 0, 'a refused CAS (example)').toBeGreaterThan(0)
    expect(coverage.get('call:revokeGrant') ?? 0, 'a Share removal (example)').toBeGreaterThan(0)
  }, 300_000)

  it('keeps a row menu on its own resource and bits across crossed openings', async () => {
    await checkGenerated(menuEvents, Math.ceil(RUNS / 4), 20, [lateBitsOnCrossedMenu])
  }, 300_000)

  it('keeps a running host Move in its dialog and its resource undraggable', async () => {
    coverage.clear()
    await checkGenerated(moveEvents, Math.ceil(RUNS / 2), 24, [closeDuringMove])
    expect(coverage.get('call:moveResource') ?? 0).toBeGreaterThan(0)
  }, 300_000)

  it('measures the generation checks of the host Move paths (their cost bound)', async () => {
    const w = await mountWorld(exampleScheduler())
    try {
      await fc.asyncModelRun(() => ({ model: w.model, real: w }), oneCommittedMove())
      await rest(w)
      checkAtRest(w)
      expect(w.calls.filter(call => call.op === 'moveResource')).toHaveLength(1)
      expect(w.toasts.map(toast => toast.tone)).toEqual(['success'])
      expect(w.genCalls.filter(call => call.host)).toHaveLength(MOVE_COMMITTED_CHECKS)
    } finally {
      await unmountWorld(w)
    }
    const verified = await mountWorld(exampleScheduler())
    try {
      await fc.asyncModelRun(
        () => ({ model: verified.model, real: verified }),
        moveVerifiedAfterRejection()
      )
      await rest(verified)
      checkAtRest(verified)
      expect(verified.calls.filter(call => call.op === 'moveResource')).toHaveLength(1)
      expect(verified.genCalls.filter(call => call.host)).toHaveLength(MOVE_VERIFIED_CHECKS)
    } finally {
      await unmountWorld(verified)
    }
    const refused = await mountWorld(exampleScheduler())
    try {
      await fc.asyncModelRun(
        () => ({ model: refused.model, real: refused }),
        moveAfterRemoteChange()
      )
      await rest(refused)
      checkAtRest(refused)
      expect(refused.calls.filter(call => call.op === 'moveResource')).toHaveLength(0)
      expect(refused.genCalls.filter(call => call.host)).toHaveLength(MOVE_REFUSED_CHECKS)
    } finally {
      await unmountWorld(refused)
    }
    const lost = await mountWorld(exampleScheduler())
    try {
      await fc.asyncModelRun(() => ({ model: lost.model, real: lost }), moveLostBeforeDispatch())
      await rest(lost)
      checkAtRest(lost)
      expect(lost.calls.filter(call => call.op === 'moveResource')).toHaveLength(0)
      expect(lost.genCalls.filter(call => call.host)).toHaveLength(MOVE_UNSENT_CHECKS)
    } finally {
      await unmountWorld(lost)
    }
  }, 60_000)
})

describe('GfsActionHost — model-based oracle: upload generation checks (K1)', () => {
  it('charges two crossed uploads only their own generation checks', async () => {
    await atRestAfter(crossedUploads(), w => {
      expect(w.calls.filter(call => call.op === 'createFileFromPath')).toHaveLength(2)
      expect(uploadChecks(w)).toHaveLength(4)
      expect(atRestViolations(w)).toEqual([])
    })
  })

  it('holds an upload that never shares a check to its own bound', async () => {
    // The dropped upload afterwards leaves a bound of one unused: pooled with
    // it, the extra check would fit.
    await atRestAfter(
      [
        new DuplicateNextUploadCheck(),
        ...uploadTo('Docs', 'report.txt'),
        ...droppedUpload('Quarterly'),
      ],
      w => {
        const [first, dropped] = uploadsOf(w)
        expect(first?.toastedAt).not.toBeNull()
        expect(dropped?.calls).toEqual([])
        expect(dropped?.toastedAt).toBeNull()
        expect(uploadChecks(w)).toHaveLength(3)
        expect(atRestViolations(w)).toEqual([
          'K1: createFileFromPath #1 asked main 3 times for a bound of 2',
        ])
      }
    )
  })

  it('holds two crossed uploads to the sum of their bounds', async () => {
    await atRestAfter([new DuplicateNextUploadCheck(), ...crossedUploads()], w => {
      expect(w.calls.filter(call => call.op === 'createFileFromPath')).toHaveLength(2)
      expect(atRestViolations(w)).toEqual(['K1: uploads #1,#2 asked main 5 times for a bound of 4'])
    })
  })

  it('ends an upload at its toast, so later uploads cannot cover its extra check', async () => {
    // Were the first upload live past its toast, the third one's checks would
    // join it with the dropped one, and 5 checks would fit their bound of 5.
    await atRestAfter(
      [
        new DuplicateNextUploadCheck(),
        ...uploadTo('Docs', 'report.txt'),
        ...droppedUpload('Quarterly'),
        ...uploadTo('Archive', 'notes.txt'),
      ],
      w => {
        expect(uploadsOf(w).map(s => s.calls.length)).toEqual([1, 0, 1])
        expect(uploadChecks(w)).toHaveLength(5)
        expect(atRestViolations(w)).toEqual([
          'K1: createFileFromPath #1 asked main 3 times for a bound of 2',
        ])
      }
    )
  })

  it('accepts two uploads aborted together after their write checks', async () => {
    await atRestAfter(
      [
        new OpenMenuOn('Quarterly'),
        new Settle(),
        new Choose('upload-file'),
        new Settle(),
        new BitsAge(),
        new HoldBits(QUARTER),
        new Pick('notes.txt'),
        new Settle(),
        new OpenMenuOn('Docs'),
        new Settle(),
        new Choose('upload-file'),
        new Settle(),
        new Pick('report.txt'),
        new StepUntilChecks('upload', 1),
        new ReleaseBits(QUARTER),
        new StepUntilChecks('upload', 2),
        new Revoke(),
        new Settle(),
      ],
      w => {
        expect(uploadsOf(w).map(s => [s.calls.length, s.toastedAt])).toEqual([
          [0, null],
          [0, null],
        ])
        expect(uploadChecks(w)).toHaveLength(2)
        expect(atRestViolations(w)).toEqual([])
      }
    )
  })

  it('accepts an upload opened after another one aborted', async () => {
    await atRestAfter(
      [
        new OpenMenuOn('Docs'),
        new Settle(),
        new Choose('upload-file'),
        new Settle(),
        new Pick('report.txt'),
        new StepUntilChecks('upload', 1),
        new Revoke(),
        new Settle(),
        new RetryAccess(),
        new Settle(),
        ...uploadTo('Archive', 'notes.txt'),
      ],
      w => {
        expect(uploadsOf(w).map(s => [s.calls.length, s.toastedAt === null])).toEqual([
          [0, true],
          [1, false],
        ])
        expect(uploadChecks(w)).toHaveLength(3)
        expect(atRestViolations(w)).toEqual([])
      }
    )
  })

  it('misses an extra check that an earlier upload without a toast leaves room for', async () => {
    // A known limit, pinned so it stays deliberate: an upload with no toast
    // stays live until rest, so every later upload is grouped with it, and
    // the bound it left unused absorbs one extra check of theirs. The same
    // happens inside a real crossing when a member aborted or asked for no
    // outcome. Telling the asker apart needs the check's identity, which the
    // host does not expose.
    await atRestAfter(
      [
        ...droppedUpload('Quarterly'),
        new DuplicateNextUploadCheck(),
        ...uploadTo('Docs', 'report.txt'),
      ],
      w => {
        expect(uploadsOf(w).map(s => s.calls.length)).toEqual([0, 1])
        expect(uploadChecks(w)).toHaveLength(3)
        expect(atRestViolations(w)).toEqual([])
      }
    )
  })

  it('flags an upload generation check asked when no upload is live', async () => {
    await atRestAfter(
      [
        new UploadCheckOnNextGesture(),
        ...uploadTo('Docs', 'report.txt'),
        new OpenMenuOn('notes.txt'),
        new Settle(),
        new Choose('download'),
        new Settle(),
      ],
      w => {
        const [upload] = uploadsOf(w)
        const late = uploadChecks(w).at(-1)!
        expect(uploadChecks(w)).toHaveLength(3)
        expect(late.at).toBeGreaterThan(upload!.toastedAt!)
        expect(atRestViolations(w)).toEqual([
          `K1: an upload generation check at ${late.at} has no live upload`,
        ])
      }
    )
  })

  it('accepts an upload aborted on its name retry, after its first request', async () => {
    // Archive's children are never listed, so the second upload of the same
    // name only learns of the first from the server's conflict, and retries.
    await atRestAfter(
      [
        ...uploadTo('Archive', 'notes.txt'),
        new OpenMenuOn('Archive'),
        new Settle(),
        new Choose('upload-file'),
        new Settle(),
        new Pick('notes.txt'),
        new StepUntilChecks('upload', 4),
        new Revoke(),
        new Settle(),
      ],
      w => {
        const retried = uploadsOf(w)[1]!
        expect(retried.calls.map(call => call.rejected ?? false)).toEqual([true])
        expect(retried.toastedAt).toBeNull()
        expect(uploadChecks(w)).toHaveLength(4)
        expect(atRestViolations(w)).toEqual([])
      }
    )
  })
})
