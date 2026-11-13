import { randomBytes, randomUUID } from 'node:crypto'
import type { Pool, QueryConfig } from 'pg'
import {
  type AuthenticatedExternalSession,
  type ExternalGfsAuthority,
  resolveExternalGfsAuthorityForSession,
} from '../../gfs/externalAuthority.js'
import {
  GFSC_READ_TRANSIENT_NO_RESPONSE,
  type GfscReadResult,
  mintExternalGfsReadToken,
  readGfsc,
} from '../../gfs/externalGfsRead.js'
import { ProcessMemoryRateLimiter } from '../../middleware/processMemoryRateLimiter.js'
import type { Logger } from '../../observability/logger.js'
import {
  gfsWatchCmdDroppedTotal,
  gfsWatchConnectionsActive,
  gfsWatchDisconnectsTotal,
  gfsWatchExpansionFailclosedTotal,
  gfsWatchFramesSentTotal,
} from '../../observability/metrics.js'
import { STREAM_HEADERS } from '../../routes/streamHeaders.js'
import {
  type ExternalSessionCurrentness,
  observeExternalSessionCurrentness,
} from '../auth/externalSessionCurrentnessObserver.js'
import {
  type GfsKey,
  MAX_DRIVES_PER_SET,
  MAX_KEYS_PER_SET,
  type Rid32,
  type Uuid,
  type WatchPrincipalKind,
  byKey,
  drivesOf,
  groupBy,
  keyDrive,
  keyKind,
  kindOf,
  normUid,
  positiveGeneration,
  principalOf,
  rid,
  rids,
  toRid32,
} from './keys.js'
import { type GfsWatchListenerDeps, createGfsWatchListener, massCloseSpreadMs } from './listener.js'
import type {
  AuthzKey,
  ResourceChangeOp,
  ResourceChanged,
  SessionHint,
  WatchCmd,
} from './notifySchemas.js'
import { type ReadSlots, createReadSlots, runLimited } from './readSlots.js'
import { type RecentDirty, createRecentDirty } from './recentDirty.js'
import { FAILED, type TimerHandle, type WatchClock, createWatchRuntime } from './runtime.js'

// ─── Limits and deadlines ─────────────────────────────────────────────────

export const GFS_WATCH_DEFAULT_HEARTBEAT_MS = 20_000
export const GFS_WATCH_DEFAULT_MAX_LIFETIME_MS = 120 * 60_000
export const GFS_WATCH_MAX_CONNECTIONS = 256
export const GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL = 8
/**
 * A forged command with s = 2^53 - 1 would otherwise pin `lastSeq` and make
 * every legitimate PUT of the connection look stale. The client restarts its
 * sequence at every `ready`, so a healthy client stays four orders of
 * magnitude below this window.
 */
export const GFS_WATCH_SEQ_WINDOW = 1024
/** Authorization budget of one op; always at least 1 s before its server deadline. */
export const GFS_WATCH_AUTH_BUDGET_MS = 6_000
const AUTH_DEADLINE_MARGIN_MS = 1_000
export const GFS_WATCH_DELTA_SERVER_DEADLINE_MS = 10_000
export const GFS_WATCH_READ_TIMEOUT_MS = 5_000
const READ_PARALLELISM = 4
const FLUSH_WINDOW_MS = 250
const MAX_BUFFERED_BYTES = 64 * 1024
const DRAIN_TIMEOUT_MS = 5_000
const DIRTY_RIDS_CAP = 1_024
/** gfsc's decision cache (5 s) plus NOTIFY latency: a suspect key is not worth retrying sooner. */
const SUSPECT_RETRY_FLOOR_MS = 6_000
const KEY_CAP_RETRY_FLOOR_MS = 60_000
const MIN_RETRY_AFTER_MS = 1_000
const DEFAULT_CLOSE_RETRY_AFTER_SEC = 2
const ADMISSION_RETRY_AFTER_SEC = 5
/** Per-principal authorization budget, separate from the GFS `resource` bucket. */
export const GFS_WATCH_AUTH_PER_MIN = 240

/**
 * Ancestry of every requested resource, the resource itself first, cut at a
 * tombstoned row like gfsc's own chain. No drive filter: a resource id is a
 * global primary key, so its chain is the same from any drive, and a key whose
 * drive is not the resource's gets a 404 from gfsc anyway. A cycle stops the
 * recursion and is reported, so the op defers instead of trusting a chain
 * gfsc would compute differently.
 */
export const GFS_WATCH_ANCESTRY_CTE = `
  WITH RECURSIVE requested(resource_id) AS (
    SELECT DISTINCT unnest($1::uuid[])
  ), chain AS (
    SELECT q.resource_id AS requested_id, r.resource_id AS ancestor_id,
           r.parent_resource_id, 0 AS depth, ARRAY[r.resource_id] AS visited, false AS cycle
      FROM requested q
      JOIN gfs_resources r ON r.resource_id = q.resource_id
     WHERE r.deleted_at IS NULL
    UNION ALL
    SELECT c.requested_id, r.resource_id, r.parent_resource_id, c.depth + 1,
           c.visited || r.resource_id, r.resource_id = ANY(c.visited)
      FROM chain c
      JOIN gfs_resources r ON r.resource_id = c.parent_resource_id
     WHERE NOT c.cycle AND r.deleted_at IS NULL
  )
  SELECT requested_id::text AS requested_id, ancestor_id::text AS ancestor_id, cycle
    FROM chain
   ORDER BY requested_id, depth`

const CTE_QUERY_TIMEOUT_MS = 2_000

const AUTHZ_WINDOW_MS = 250
/**
 * Ids one authorization window may accumulate. NOTIFY needs no privilege, so
 * any database role can name ids without bound, and the window's cost (the
 * expansion parameters, the flush) grows with them. Past the cap the window
 * fails closed instead: every connected user is held and reauthorized, a cost
 * that does not depend on how many ids arrived.
 */
export const GFS_WATCH_AUTHZ_WINDOW_MAX_IDS = 10_000
const EXPANSION_RETRY_MS = 500
const FAIL_CLOSED_CEILING_MS = 5_000

/**
 * Active members of the changed teams. An inactive member needs no
 * expansion: its own membership change already names it.
 */
export const GFS_WATCH_EXPAND_TEAMS_SQL = `SELECT user_id::text AS u FROM team_members
  WHERE team_id = ANY($1::uuid[]) AND status = 'active'`

/** Desktop users linked to the changed admins; revoked links stay in the table as history. */
export const GFS_WATCH_EXPAND_ADMINS_SQL = `SELECT user_id::text AS u FROM gfs_desktop_operator_links
  WHERE control_admin_id = ANY($1::uuid[]) AND state = 'active'`

const ROOTS_WINDOW_MS = 250
const ROOTS_MIN_INTERVAL_MS = 2_000
const SESSION_WINDOW_MS = 250

/**
 * Users who list a changed resource among their roots: direct grantees with
 * `read` (a root listing only returns resources granted or shared directly),
 * and the active members of a team grantee. subject_id is TEXT and holds
 * non-uuid ids for host and context subjects, so it is compared as text: a
 * `::uuid` cast would fail the whole window on the first such row.
 */
export const GFS_WATCH_ROOTS_GRANTEES_SQL = `WITH g AS (
    SELECT subject_type, subject_id FROM gfs_grants
     WHERE resource_id = ANY($1::uuid[]) AND 'read' = ANY(permissions)
    UNION
    SELECT subject_type, subject_id FROM gfs_shares
     WHERE resource_id = ANY($1::uuid[]) AND 'read' = ANY(permissions))
  SELECT g.subject_id AS u FROM g WHERE g.subject_type = 'user'
  UNION
  SELECT tm.user_id::text AS u FROM g
    JOIN team_members tm ON tm.team_id::text = g.subject_id AND tm.status = 'active'
   WHERE g.subject_type = 'team'`

/** The row is the authority on a session hint; the hint only says which users to read. */
export const GFS_WATCH_SESSION_CONFIRM_SQL = `SELECT id::text AS id, lifecycle_state, lifecycle_version
  FROM users WHERE id = ANY($1::uuid[])`

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * The response a watch connection streams to. Express's `Response` satisfies
 * it once `onGone` is bound to the response 'close' and 'error' events and the
 * request 'aborted' event.
 */
export interface WatchSocket {
  readonly headersSent: boolean
  readonly writableLength: number
  writeHead(status: number, headers: Readonly<Record<string, string>>): unknown
  flushHeaders(): unknown
  write(chunk: string): boolean
  end(): unknown
  once(event: 'drain', listener: () => void): unknown
  /** Registers the client-gone listener: the client left or the socket failed. */
  onGone(listener: () => void): unknown
}

export type WatchCloseReason =
  | 'listener_lost'
  | 'max_lifetime'
  | 'reauthorize'
  | 'session_expired'
  | 'server_shutdown'
  | 'client_gone'
  | 'deadline'
  | 'internal'
  | 'slow_consumer'

/** Reasons the client is told about before the stream ends. */
const CLOSING_FRAME_REASONS: ReadonlySet<WatchCloseReason> = new Set([
  'listener_lost',
  'max_lifetime',
  'reauthorize',
  'session_expired',
  'server_shutdown',
])

export type WatchBinding = { userId: Uuid; authGeneration: number }

type KeyRec = { state: 'authorizing' | 'accepted' | 'rejected'; chain: Rid32[] | null }

type ConnTimers = {
  flush: TimerHandle | null
  exp: TimerHandle | null
  heartbeat: TimerHandle | null
  lifetime: TimerHandle | null
  rootsTrailing: TimerHandle | null
  drain: TimerHandle | null
}

export type WatchOp = {
  kind: 'open' | 'delta'
  seq: number
  opId: string
  added: Set<GfsKey>
  deferred: Set<GfsKey>
  chains: Map<GfsKey, Rid32[]>
  noChain: Set<GfsKey>
  tokens: Map<string, string>
  authCtl: AbortController
  signal: AbortSignal
  dirtyRids: Set<Rid32>
  dirtyOverflow: boolean
  retryFloorMs: number
  loadDeferred: boolean
  srvDeadline: number
  tAuth: TimerHandle | null
  tSrv: TimerHandle | null
}

export type WatchConnection = {
  readonly connId: string
  readonly binding: WatchBinding
  principalKind: WatchPrincipalKind
  readonly authentication: AuthenticatedExternalSession
  readonly exp: number
  phase: 'opening' | 'ready' | 'closed'
  readonly closeCtl: AbortController
  closeReason: WatchCloseReason | null
  closeRetryAfterMs: number | null
  authority: ExternalGfsAuthority | null
  readonly socket: WatchSocket
  lastSeq: number
  keys: Map<GfsKey, KeyRec>
  resourceRefs: Map<Rid32, number>
  ancestorRefs: Map<Rid32, number>
  pending: Set<GfsKey>
  op: WatchOp | null
  nextCmd: { seq: number; keys: ReadonlySet<GfsKey>; r: Uuid } | null
  timers: ConnTimers
  rootsLastSentAt: number
}

export type WatchFrame =
  | { type: 'heartbeat' }
  | { type: 'changed'; keys: GfsKey[] }
  | { type: 'roots_changed' }
  | {
      type: 'subscriptions'
      seq: number
      accepted: GfsKey[]
      rejected: GfsKey[]
      deferred: GfsKey[]
      retryAfterMs?: number
    }
  | { type: 'stream.closing'; reason: WatchCloseReason; retryAfterMs?: number }

export type WatchOpenInput = {
  authentication: AuthenticatedExternalSession
  keys: ReadonlySet<GfsKey>
  socket: WatchSocket
  /** Monotonic instant on the registry clock (`registry.now()`) at which T_srv expires. */
  srvDeadline: number
  /** Aborted by T_srv and by the client leaving; composed into the open op's signal. */
  watchSignal: AbortSignal
  /** The request id of the open; its reads to gfsc carry it. */
  requestId: string
}

/**
 * What the HTTP handler writes for an open. `classify` hands an error back to
 * the handler's classifier (session or authority origin); `none` means there
 * is nothing to write (the client left, or the stream headers already went).
 */
export type WatchOpenOutcome =
  | { kind: 'stream' }
  | { kind: 'reply'; status: 400 | 401 | 429 | 503; code: string; retryAfterSec?: number }
  | { kind: 'classify'; origin: 'session' | 'authority'; error: unknown }
  | { kind: 'none' }

/** The registry's own pool: the ancestry query and the currentness observation both run on it. */
type WatchPoolLike = Pick<Pool, 'query'>

type AuthBudget = {
  hit(
    key: string
  ): Promise<{ outcome: 'allowed' | 'denied'; resetMs: number } | { outcome: 'key_cap_reached' }>
}

export type GfsWatchRegistryDeps = {
  /** Connection string of the dedicated LISTEN client. */
  listenConnectionString: string
  watchPool: WatchPoolLike
  clock?: WatchClock
  log?: Logger
  heartbeatMs?: number
  maxLifetimeMs?: number
  authBudget?: AuthBudget
  readSlots?: ReadSlots
  recentDirty?: RecentDirty
  mintReadToken?: typeof mintExternalGfsReadToken
  readGfsc?: typeof readGfsc
  observeCurrentness?: (
    authentication: AuthenticatedExternalSession
  ) => Promise<ExternalSessionCurrentness>
  resolveAuthority?: typeof resolveExternalGfsAuthorityForSession
  createListenClient?: GfsWatchListenerDeps<WatchConnection>['createClient']
  instanceId?: string
}

/**
 * The watch binding of an authenticated V1 session: user and authorization
 * generation as one comparable value, plus the token expiry. Null when the
 * session carries no V1 generation or either value fails its normalizer.
 */
export function watchBindingOf(
  authentication: AuthenticatedExternalSession
): (WatchBinding & { exp: number }) | null {
  const ctx = authentication.authorityContext
  if (ctx.contract !== 'v1') return null
  const userId = normUid(ctx.userId)
  const authGeneration = positiveGeneration(ctx.authGeneration)
  const exp = authentication.tokenClaims.exp
  if (userId === null || authGeneration === null || typeof exp !== 'number') return null
  return { userId, authGeneration, exp }
}

function ndjson(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

function addToIndex<K>(idx: Map<K, Set<WatchConnection>>, key: K, conn: WatchConnection): void {
  const set = idx.get(key)
  if (set) set.add(conn)
  else idx.set(key, new Set([conn]))
}

// Empty entries are deleted: an index keyed by user or rid that only grows
// leaks in a process that lives for days.
function removeFromIndex<K>(
  idx: Map<K, Set<WatchConnection>>,
  key: K,
  conn: WatchConnection
): void {
  const set = idx.get(key)
  if (!set) return
  set.delete(conn)
  if (set.size === 0) idx.delete(key)
}

/**
 * The process-wide registry of GFS watch streams: one long-lived stream per
 * desktop main process, whose subscription set changes in place through
 * commands routed by NOTIFY to the replica that owns the connection.
 *
 * Every mutation of a connection runs synchronously between awaits, and every
 * await of an op is followed by a gate (`conn.phase !== 'closed' &&
 * conn.op === op`) before any write to indexes, counters or the socket.
 */
export function createGfsWatchRegistry(deps: GfsWatchRegistryDeps) {
  const heartbeatMs = deps.heartbeatMs ?? GFS_WATCH_DEFAULT_HEARTBEAT_MS
  const maxLifetimeMs = deps.maxLifetimeMs ?? GFS_WATCH_DEFAULT_MAX_LIFETIME_MS
  const mintReadToken = deps.mintReadToken ?? mintExternalGfsReadToken
  const readGfscFn = deps.readGfsc ?? readGfsc
  const resolveAuthority = deps.resolveAuthority ?? resolveExternalGfsAuthorityForSession
  const observeCurrentness =
    deps.observeCurrentness ??
    ((a: AuthenticatedExternalSession) =>
      observeExternalSessionCurrentness(a, { db: deps.watchPool }))
  const authBudget: AuthBudget =
    deps.authBudget ?? new ProcessMemoryRateLimiter(GFS_WATCH_AUTH_PER_MIN)

  // closeConn is hoisted, so the runtime can close a connection whose entry point threw.
  const rt = createWatchRuntime<WatchConnection>({
    closeConnInternal: conn => closeConn(conn, 'internal'),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.log ? { log: deps.log } : {}),
  })
  const recentDirty = deps.recentDirty ?? createRecentDirty(rt.now)
  const readSlots = deps.readSlots ?? createReadSlots(rt.now)

  // ─── State ───────────────────────────────────────────────────────────────
  const byConnId = new Map<string, WatchConnection>()
  const byUser = new Map<Uuid, Set<WatchConnection>>()
  const byResource = new Map<Rid32, Set<WatchConnection>>()
  const byAncestor = new Map<Rid32, Set<WatchConnection>>()
  const opsInFlight = new Set<WatchConnection>()
  const admittedPerPrincipal = new Map<Uuid, number>()

  // Retention and the authorization/roots windows. Every reader (`retenida`,
  // the open's admission, `closeConn`) honours them, so a retained user can
  // neither receive a decision nor open a stream.
  const holdUsers = new Map<Uuid, number>()
  const reauthPending = { users: new Set<Uuid>(), conns: new Set<WatchConnection>() }
  const rootsPending = new Set<WatchConnection>()
  const linkedOperators = new Set<WatchConnection>()

  // Process-level window handles; `rt.cancel` takes the holder and the field.
  const windows: {
    authzWindow: TimerHandle | null
    expansionRetry: TimerHandle | null
    failClosedTimer: TimerHandle | null
    rootsWindow: TimerHandle | null
    sessionWindow: TimerHandle | null
  } = {
    authzWindow: null,
    expansionRetry: null,
    failClosedTimer: null,
    rootsWindow: null,
    sessionWindow: null,
  }
  // Team and admin ids still to expand, and those whose expansion failed once.
  let authzTeams = new Set<Uuid>()
  let authzAdmins = new Set<Uuid>()
  let retryTeams = new Set<Uuid>()
  let retryAdmins = new Set<Uuid>()
  // The fail-closed's own hold reason: a user enters (and is held) once,
  // and the copy that empties it is what gets released.
  let failClosedPending = new Set<Uuid>()
  // Rids of the roots window whose direct grantees must hear of the change.
  let rootsRids = new Set<Rid32>()
  // The session hint's own hold reason, released through the copy that empties it.
  let sessionPending = new Set<Uuid>()
  // The users of each confirmation awaiting its query: still held, by no pending set.
  const sessionConfirming = new Set<ReadonlySet<Uuid>>()
  let lastFailClosedAt = Number.NEGATIVE_INFINITY
  // Bumped on every process transition: a window that resumes from its
  // await under another epoch describes connections that no longer exist.
  let windowEpoch = 0

  const listener = createGfsWatchListener<WatchConnection>({
    connectionString: deps.listenConnectionString,
    runtime: rt,
    recentDirty,
    connections: () => byConnId.values(),
    opsInFlight: () => opsInFlight,
    closeConn: (conn, reason, opts) => closeConn(conn, reason, opts),
    onCmd,
    onResourceChanged,
    onAuthzChanged,
    onSessionHint,
    resetWindows,
    onExpansionFailed,
    ...(deps.createListenClient ? { createClient: deps.createListenClient } : {}),
    ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
  })

  function hold(uid: Uuid): void {
    holdUsers.set(uid, (holdUsers.get(uid) ?? 0) + 1)
  }

  function unhold(uid: Uuid): void {
    const n = holdUsers.get(uid) ?? 0
    if (n <= 1) holdUsers.delete(uid)
    else holdUsers.set(uid, n - 1)
  }

  function usuarioRetenido(uid: Uuid): boolean {
    return reauthPending.users.has(uid) || (holdUsers.get(uid) ?? 0) > 0
  }

  function retenida(conn: WatchConnection): boolean {
    return reauthPending.conns.has(conn) || usuarioRetenido(conn.binding.userId)
  }

  const shuttingDown = () => listener.state.shuttingDown

  /**
   * Synchronous; both process transitions call it, before closing every
   * connection. What the windows hold describes connections about to close,
   * so applying it after a reconnect would reauthorize streams opened against
   * the new state.
   */
  function resetWindows(): void {
    windowEpoch += 1
    resetAuthzWindow()
    resetFailClosed()
    resetRootsWindow()
    resetSessionWindow()
  }

  /** A trailing `roots_changed` belongs to its connection, and its closeConn cancels it. */
  function resetRootsWindow(): void {
    rt.cancel(windows, 'rootsWindow')
    rootsRids = new Set()
    rootsPending.clear()
  }

  // A confirmation already past its window releases its own users in its finally.
  function resetSessionWindow(): void {
    rt.cancel(windows, 'sessionWindow')
    const u = sessionPending
    sessionPending = new Set()
    for (const uid of u) unhold(uid)
  }

  function resetAuthzWindow(): void {
    rt.cancel(windows, 'authzWindow', 'expansionRetry')
    authzTeams = new Set()
    authzAdmins = new Set()
    retryTeams = new Set()
    retryAdmins = new Set()
    reauthPending.users.clear()
    reauthPending.conns.clear()
  }

  function resetFailClosed(): void {
    rt.cancel(windows, 'failClosedTimer')
    const u = failClosedPending
    failClosedPending = new Set()
    for (const uid of u) unhold(uid)
  }

  // ─── Authorization window ────────────────────────────────────────────────

  function onAuthzChanged(key: AuthzKey): void {
    if (shuttingDown()) return
    if (byUser.size === 0) return
    if (key.kind === 'u' || (key.kind === 's' && key.t === 'user')) {
      if (key.id === null) return
      reauthPending.users.add(key.id)
    } else if (key.kind === 's' && key.t === 'team') {
      if (key.id === null) return
      authzTeams.add(key.id)
    } else if (key.kind === 'a') {
      authzAdmins.add(key.id)
    } else {
      // operator, host and context subjects have no desktop user.
      return
    }
    // Measured on arrival, where the accumulation grows: the window then
    // never holds more than the cap, whatever the volume of the burst.
    if (
      authzTeams.size + authzAdmins.size + reauthPending.users.size >
      GFS_WATCH_AUTHZ_WINDOW_MAX_IDS
    ) {
      // The fail-closed holds every connected user, which covers every id
      // dropped here, so the accumulation is released before it runs.
      authzTeams = new Set()
      authzAdmins = new Set()
      reauthPending.users.clear()
      onExpansionFailed()
      return
    }
    armAuthzWindow()
  }

  /** The only place that arms the window; the a=1 path of resource changes shares it. */
  function armAuthzWindow(): void {
    if (windows.authzWindow === null) {
      windows.authzWindow = rt.timer(AUTHZ_WINDOW_MS, () =>
        rt.guardedTick('authz-window', onAuthzWindow)
      )
    }
  }

  async function onAuthzWindow(): Promise<void> {
    windows.authzWindow = null
    // Own state first: a key that arrives during the expansion opens another window.
    const t = authzTeams
    const a = authzAdmins
    authzTeams = new Set()
    authzAdmins = new Set()
    if (shuttingDown()) return
    const e = windowEpoch
    const r = t.size > 0 || a.size > 0 ? await expand(t, a) : new Set<Uuid>()
    if (shuttingDown() || windowEpoch !== e) return
    if (r === FAILED) {
      // Accumulated, so two failed windows share one retry. reauthPending
      // stays as it is: its users remain retained until the retry flushes.
      for (const id of t) retryTeams.add(id)
      for (const id of a) retryAdmins.add(id)
      // Failed windows add up while the retry waits, so the window cap alone
      // does not bound the retry's query. Past it, fail closed instead. The
      // retry stays armed: with nothing left to expand it still flushes the
      // direct users and connections this window kept retained.
      if (retryTeams.size + retryAdmins.size > GFS_WATCH_AUTHZ_WINDOW_MAX_IDS) {
        retryTeams = new Set()
        retryAdmins = new Set()
        onExpansionFailed()
      }
      if (windows.expansionRetry === null) {
        windows.expansionRetry = rt.timer(EXPANSION_RETRY_MS, () =>
          rt.guardedTick('expansion-retry', onExpansionRetry)
        )
      }
      return
    }
    addExpanded(r)
    flushReauth()
  }

  async function onExpansionRetry(): Promise<void> {
    windows.expansionRetry = null
    const t = retryTeams
    const a = retryAdmins
    retryTeams = new Set()
    retryAdmins = new Set()
    if (shuttingDown()) return
    const e = windowEpoch
    const r = await expand(t, a)
    if (shuttingDown() || windowEpoch !== e) return
    if (r === FAILED) onExpansionFailed()
    else addExpanded(r)
    // The direct users and the a=1 connections do not wait for the fail-closed ceiling.
    flushReauth()
  }

  /** At most one query per kind and window, on the watch pool. */
  async function expand(teams: ReadonlySet<Uuid>, admins: ReadonlySet<Uuid>) {
    const qs: Promise<{ rows: unknown[] } | typeof FAILED>[] = []
    if (teams.size > 0) {
      qs.push(
        rt.total(
          () => deps.watchPool.query({ text: GFS_WATCH_EXPAND_TEAMS_SQL, values: [[...teams]] }),
          'expansion'
        )
      )
    }
    if (admins.size > 0) {
      qs.push(
        rt.total(
          () => deps.watchPool.query({ text: GFS_WATCH_EXPAND_ADMINS_SQL, values: [[...admins]] }),
          'expansion'
        )
      )
    }
    const rs = await Promise.all(qs)
    const users = new Set<Uuid>()
    for (const r of rs) {
      if (r === FAILED) return FAILED
      // Projected through the normalizer: the pg row keeps Postgres' text form.
      for (const row of r.rows as { u?: unknown }[]) {
        const u = normUid(row.u)
        if (u !== null) users.add(u)
      }
    }
    return users
  }

  function addExpanded(users: ReadonlySet<Uuid>): void {
    for (const u of users) if (byUser.has(u)) reauthPending.users.add(u)
  }

  /** Synchronous. Targets are read from the current byUser, so a stream opened meanwhile closes too. */
  function flushReauth(): void {
    const targets = new Set(reauthPending.conns)
    for (const u of reauthPending.users) for (const conn of byUser.get(u) ?? []) targets.add(conn)
    reauthPending.users.clear()
    reauthPending.conns.clear()
    closeAllSpread([...targets], 'reauthorize')
  }

  function closeAllSpread(victims: WatchConnection[], reason: WatchCloseReason): void {
    const spreadMs = massCloseSpreadMs(victims.length)
    for (const conn of victims) rt.guarded(conn, () => closeConn(conn, reason, { spreadMs }))
  }

  // ─── Fail-closed ─────────────────────────────────────────────────────────

  /**
   * Synchronous. Every connected user is retained at once, whatever its
   * principal kind; the close waits for the ceiling of one application every
   * 5 s per replica.
   */
  function onExpansionFailed(): void {
    if (shuttingDown()) return
    gfsWatchExpansionFailclosedTotal.inc()
    for (const uid of byUser.keys()) {
      if (!failClosedPending.has(uid)) {
        hold(uid)
        failClosedPending.add(uid)
      }
    }
    if (windows.failClosedTimer === null) {
      const d = Math.max(0, lastFailClosedAt + FAIL_CLOSED_CEILING_MS - rt.now())
      windows.failClosedTimer = rt.timer(d, () =>
        rt.guardedTick('failclosed-apply', applyFailClosed)
      )
    }
  }

  function applyFailClosed(): void {
    windows.failClosedTimer = null
    // A failure after this point opens a new reason with its own holds.
    const u = failClosedPending
    failClosedPending = new Set()
    lastFailClosedAt = rt.now()
    try {
      if (shuttingDown()) return
      const victims: WatchConnection[] = []
      for (const uid of u) for (const conn of byUser.get(uid) ?? []) victims.push(conn)
      closeAllSpread(victims, 'reauthorize')
    } finally {
      // Over the copy, never byUser: a user who left meanwhile is released too.
      for (const uid of u) unhold(uid)
    }
  }

  // ─── Roots window ────────────────────────────────────────────────────────

  function onRootsHint(x: Rid32, op: ResourceChangeOp): void {
    if (shuttingDown() || byConnId.size === 0) return
    // A linked operator lists the whole drive, so any visible change of any
    // resource changes its roots. With one drive per instance, every linked
    // operator is exactly the drive's operators.
    for (const conn of linkedOperators) rootsPending.add(conn)
    // A new resource has no grants yet, and one granted in the same
    // transaction fires its own authorization hint.
    if (op !== 'i' && byUser.size > 0) rootsRids.add(x)
    if (rootsPending.size > 0 || rootsRids.size > 0) armRootsWindow()
  }

  function armRootsWindow(): void {
    if (windows.rootsWindow === null) {
      windows.rootsWindow = rt.timer(ROOTS_WINDOW_MS, () =>
        rt.guardedTick('roots-window', onRootsWindow)
      )
    }
  }

  async function onRootsWindow(): Promise<void> {
    windows.rootsWindow = null
    const r = rootsRids
    rootsRids = new Set()
    if (shuttingDown()) return
    const e = windowEpoch
    if (r.size > 0) {
      const res = await rt.total(
        () => deps.watchPool.query({ text: GFS_WATCH_ROOTS_GRANTEES_SQL, values: [rids(r)] }),
        'roots'
      )
      if (shuttingDown() || windowEpoch !== e) return
      // A failed query only loses a roots notice, never a revocation: the
      // client refetches its roots on every ready and on focus.
      if (res !== FAILED) {
        for (const row of res.rows as { u?: unknown }[]) {
          const u = normUid(row.u)
          if (u === null) continue
          for (const conn of byUser.get(u) ?? []) rootsPending.add(conn)
        }
      }
    }
    const p = [...rootsPending]
    rootsPending.clear()
    for (const conn of p) rt.guarded(conn, () => emitRoots(conn))
  }

  /** At most one `roots_changed` every 2 s per connection, the last one trailing. */
  function emitRoots(conn: WatchConnection): void {
    if (rt.now() - conn.rootsLastSentAt >= ROOTS_MIN_INTERVAL_MS) {
      // Only a frame that went out starts the interval: one dropped while the
      // connection was opening or retained must not delay the next.
      if (send(conn, { type: 'roots_changed' })) conn.rootsLastSentAt = rt.now()
    } else if (conn.timers.rootsTrailing === null) {
      conn.timers.rootsTrailing = rt.timerAt(conn.rootsLastSentAt + ROOTS_MIN_INTERVAL_MS, () =>
        rt.guarded(conn, () => {
          conn.timers.rootsTrailing = null
          if (send(conn, { type: 'roots_changed' })) conn.rootsLastSentAt = rt.now()
        })
      )
    }
  }

  // ─── Session hints ───────────────────────────────────────────────────────

  /**
   * A session NOTIFY is only a hint: NOTIFY needs no privilege, so closing on
   * it would let any database role end every session. The user is held at
   * once and the users row decides. A version at or below the connection's
   * generation never closes, so a late NOTIFY cannot end a newer session.
   */
  function onSessionHint(hint: SessionHint): void {
    if (shuttingDown()) return
    const { uid, state, version } = hint
    let affected = false
    for (const conn of byUser.get(uid) ?? []) {
      if (state !== 'active' || version > conn.binding.authGeneration) {
        affected = true
        break
      }
    }
    if (!affected) return
    if (!sessionPending.has(uid)) {
      hold(uid)
      sessionPending.add(uid)
    }
    if (windows.sessionWindow === null) {
      windows.sessionWindow = rt.timer(SESSION_WINDOW_MS, () =>
        rt.guardedTick('session-window', onSessionWindow)
      )
    }
  }

  async function onSessionWindow(): Promise<void> {
    windows.sessionWindow = null
    // A hint for a user of U that arrives during the query opens another
    // window with its own hold.
    const u = sessionPending
    sessionPending = new Set()
    sessionConfirming.add(u)
    const e = windowEpoch
    try {
      const res = await rt.total(
        () => deps.watchPool.query({ text: GFS_WATCH_SESSION_CONFIRM_SQL, values: [[...u]] }),
        'session-confirm'
      )
      // After a process transition every connection of U is already closed.
      if (shuttingDown() || windowEpoch !== e) return
      // Keyed through the same normalizer as the hint's uid: the pg row keeps
      // Postgres' text form.
      const rows =
        res === FAILED
          ? FAILED
          : byKey(
              res.rows as {
                id?: unknown
                lifecycle_state?: unknown
                lifecycle_version?: unknown
              }[],
              row => normUid(row.id)
            )
      // The whole plan is read before the first close: a close can empty a
      // user's byUser entry, and a throw must not skip the users after it.
      const plan: [WatchConnection, WatchCloseReason][] = []
      for (const uid of u) {
        rt.guardedTick('session-confirm-user', () => {
          for (const conn of [...(byUser.get(uid) ?? [])]) {
            if (rows === FAILED) {
              // Not confirmable: the reopen authenticates again and decides.
              plan.push([conn, 'reauthorize'])
              continue
            }
            const row = rows.get(uid)
            if (!row || row.lifecycle_state !== 'active') {
              plan.push([conn, 'session_expired'])
              continue
            }
            // BIGINT arrives as a string; compared raw it would never equal the generation.
            const v = positiveGeneration(row.lifecycle_version)
            if (v === null) plan.push([conn, 'reauthorize'])
            else if (v !== conn.binding.authGeneration) plan.push([conn, 'session_expired'])
          }
        })
      }
      const spreadMs = massCloseSpreadMs(plan.length)
      for (const [conn, reason] of plan) {
        rt.guarded(conn, () => closeConn(conn, reason, { spreadMs }))
      }
    } finally {
      sessionConfirming.delete(u)
      // Over U, never byUser: a user who left meanwhile is released too.
      for (const uid of u) unhold(uid)
    }
  }

  // ─── Socket ──────────────────────────────────────────────────────────────

  /** The only writer after `ready`. Returns whether the frame was written. */
  function send(conn: WatchConnection, frame: WatchFrame, opts = { final: false }): boolean {
    if (conn.phase !== 'ready') return false
    if (frame.type === 'roots_changed' && retenida(conn)) return false
    const line = ndjson({ schemaVersion: 1, ...frame })
    if (conn.socket.writableLength + Buffer.byteLength(line) > MAX_BUFFERED_BYTES) {
      // A final frame with a full buffer is dropped: the client sees EOF.
      if (!opts.final) closeConn(conn, 'slow_consumer')
      return false
    }
    gfsWatchFramesSentTotal.inc({ frame_type: frame.type })
    if (!conn.socket.write(line) && conn.timers.drain === null) {
      conn.timers.drain = rt.timer(DRAIN_TIMEOUT_MS, () =>
        rt.guarded(conn, () => {
          conn.timers.drain = null
          closeConn(conn, 'slow_consumer')
        })
      )
      conn.socket.once('drain', () => rt.guarded(conn, () => rt.cancel(conn.timers, 'drain')))
    }
    return true
  }

  function armHeartbeat(conn: WatchConnection): void {
    conn.timers.heartbeat = rt.timer(heartbeatMs, () =>
      rt.guarded(conn, () => onHeartbeatTick(conn))
    )
  }

  function onHeartbeatTick(conn: WatchConnection): void {
    conn.timers.heartbeat = null
    if (conn.phase !== 'ready') return
    send(conn, { type: 'heartbeat' })
    // send may have closed the connection (slow consumer): rearming then would
    // leave a timer holding a closed connection forever.
    if (conn.phase === 'ready') armHeartbeat(conn)
  }

  function armLifetime(conn: WatchConnection): void {
    conn.timers.lifetime = rt.timer(maxLifetimeMs, () =>
      rt.guarded(conn, () => {
        conn.timers.lifetime = null
        closeConn(conn, 'max_lifetime')
      })
    )
  }

  /** `exp` comes from the token claims, so it is measured on the wall clock. */
  function armExp(conn: WatchConnection): void {
    conn.timers.exp = rt.timer(Math.max(0, conn.exp * 1000 - rt.wallNow()), () =>
      rt.guarded(conn, () => {
        conn.timers.exp = null
        closeConn(conn, 'session_expired')
      })
    )
  }

  // ─── Flush ───────────────────────────────────────────────────────────────

  function deliver(conn: WatchConnection, k: GfsKey): void {
    conn.pending.add(k)
    if (conn.timers.flush === null) {
      conn.timers.flush = rt.timer(FLUSH_WINDOW_MS, () => rt.guarded(conn, () => onFlush(conn)))
    }
  }

  function onFlush(conn: WatchConnection): void {
    conn.timers.flush = null
    if (retenida(conn)) {
      // Resumed, not dropped: a change has no resync to cover it, so if the
      // hold was a false hint it must still go out once the user is released.
      if (conn.pending.size > 0) {
        conn.timers.flush = rt.timer(FLUSH_WINDOW_MS, () => rt.guarded(conn, () => onFlush(conn)))
      }
      return
    }
    // Keys of the op in flight wait for its decision frame: the op may still defer them.
    const inFlight = conn.op?.added
    const ks = [...conn.pending].filter(
      k => conn.keys.get(k)?.state === 'accepted' && !inFlight?.has(k)
    )
    conn.pending = new Set()
    if (ks.length > 0) send(conn, { type: 'changed', keys: ks })
  }

  // ─── Indexes ─────────────────────────────────────────────────────────────

  function index(conn: WatchConnection, k: GfsKey, chain: Rid32[]): void {
    const r = rid(k)
    const n = (conn.resourceRefs.get(r) ?? 0) + 1
    conn.resourceRefs.set(r, n)
    if (n === 1) addToIndex(byResource, r, conn)
    for (const a of chain) {
      const m = (conn.ancestorRefs.get(a) ?? 0) + 1
      conn.ancestorRefs.set(a, m)
      if (m === 1) addToIndex(byAncestor, a, conn)
    }
    const rec = conn.keys.get(k)
    if (rec) rec.chain = chain
  }

  /** Subtracts the stored chain; idempotent. */
  function unindex(conn: WatchConnection, k: GfsKey): void {
    const rec = conn.keys.get(k)
    if (!rec || rec.chain === null) return
    const r = rid(k)
    const n = (conn.resourceRefs.get(r) ?? 0) - 1
    if (n <= 0) {
      conn.resourceRefs.delete(r)
      removeFromIndex(byResource, r, conn)
    } else conn.resourceRefs.set(r, n)
    for (const a of rec.chain) {
      const m = (conn.ancestorRefs.get(a) ?? 0) - 1
      if (m <= 0) {
        conn.ancestorRefs.delete(a)
        removeFromIndex(byAncestor, a, conn)
      } else conn.ancestorRefs.set(a, m)
    }
    rec.chain = null
  }

  // ─── Close ───────────────────────────────────────────────────────────────

  /**
   * Synchronous, idempotent and never throws. Registry memory is released
   * first, then each external effect runs in isolation: a throwing abort
   * listener or `end()` on a broken socket can neither leave the connection
   * indexed nor stop a mass close that called this.
   */
  function closeConn(
    conn: WatchConnection,
    reason: WatchCloseReason,
    opts: { spreadMs: number } = { spreadMs: 0 }
  ): void {
    if (conn.phase === 'closed') return
    const wasReady = conn.phase === 'ready'
    conn.closeRetryAfterMs = opts.spreadMs > 0 ? rt.clock.random() * opts.spreadMs : null
    if (wasReady && CLOSING_FRAME_REASONS.has(reason)) {
      const retryAfterMs = conn.closeRetryAfterMs ?? undefined
      rt.bestEffort(() =>
        send(
          conn,
          {
            type: 'stream.closing',
            reason,
            ...(retryAfterMs === undefined ? {} : { retryAfterMs: Math.round(retryAfterMs) }),
          },
          { final: true }
        )
      )
    }
    conn.closeReason = reason
    conn.phase = 'closed'
    if (conn.op) {
      rt.cancel(conn.op, 'tAuth', 'tSrv')
      opsInFlight.delete(conn)
      conn.op = null
    }
    conn.nextCmd = null
    rt.cancel(conn.timers, 'flush', 'exp', 'heartbeat', 'lifetime', 'rootsTrailing', 'drain')
    rootsPending.delete(conn)
    reauthPending.conns.delete(conn)
    linkedOperators.delete(conn)
    for (const k of conn.keys.keys()) unindex(conn, k)
    removeFromIndex(byUser, conn.binding.userId, conn)
    if (byConnId.get(conn.connId) === conn) {
      byConnId.delete(conn.connId)
      const n = (admittedPerPrincipal.get(conn.binding.userId) ?? 0) - 1
      if (n <= 0) admittedPerPrincipal.delete(conn.binding.userId)
      else admittedPerPrincipal.set(conn.binding.userId, n)
    }
    rt.bestEffort(() => {
      gfsWatchDisconnectsTotal.inc({ reason })
      gfsWatchConnectionsActive.dec({ principal_kind: conn.principalKind })
    })
    rt.bestEffort(() => conn.closeCtl.abort())
    // In `opening` without headers nothing is written here: the open's
    // outcome produces the response.
    if (wasReady || conn.socket.headersSent) rt.bestEffort(() => conn.socket.end())
  }

  // ─── Op ──────────────────────────────────────────────────────────────────

  function gate(conn: WatchConnection, op: WatchOp): boolean {
    return conn.phase !== 'closed' && conn.op === op
  }

  function newOp(
    conn: WatchConnection,
    kind: 'open' | 'delta',
    seq: number,
    added: Set<GfsKey>,
    srvDeadline: number,
    requestId: string,
    watchSignal?: AbortSignal
  ): WatchOp {
    const authCtl = new AbortController()
    const op: WatchOp = {
      kind,
      seq,
      // gfsc refuses an x-request-id that is not a uuid.
      opId: normUid(requestId) ?? randomUUID(),
      added,
      deferred: new Set(),
      chains: new Map(),
      noChain: new Set(),
      tokens: new Map(),
      authCtl,
      // Composed, not chained with an abort listener: the connection's signal
      // must not keep every finished op reachable for the stream's lifetime.
      signal: AbortSignal.any(
        watchSignal
          ? [authCtl.signal, conn.closeCtl.signal, watchSignal]
          : [authCtl.signal, conn.closeCtl.signal]
      ),
      dirtyRids: recentDirty.snapshot(),
      dirtyOverflow: recentDirty.overflowed(),
      retryFloorMs: 0,
      loadDeferred: false,
      srvDeadline,
      tAuth: null,
      tSrv: null,
    }
    op.tAuth = rt.timerAt(
      Math.min(rt.now() + GFS_WATCH_AUTH_BUDGET_MS, srvDeadline - AUTH_DEADLINE_MARGIN_MS),
      () =>
        rt.guarded(conn, () => {
          op.tAuth = null
          onAuthDeadline(conn, op)
        })
    )
    op.tSrv = rt.timerAt(srvDeadline, () =>
      rt.guarded(conn, () => {
        op.tSrv = null
        op.authCtl.abort()
      })
    )
    conn.op = op
    opsInFlight.add(conn)
    return op
  }

  /** The only way an op runs: an unexpected throw closes the connection. */
  async function runOpSafe(conn: WatchConnection, op: WatchOp): Promise<void> {
    try {
      await runOp(conn, op)
    } catch (err) {
      rt.log.error({ err, connId: conn.connId, opId: op.opId }, 'gfs watch op failed')
      if (conn.op === op) closeConn(conn, 'internal')
    }
  }

  function stillAuthorizing(conn: WatchConnection, k: GfsKey): boolean {
    return conn.keys.get(k)?.state === 'authorizing'
  }

  async function runOp(conn: WatchConnection, op: WatchOp): Promise<void> {
    // Authorization budget, before any query.
    for (const k of op.added) {
      const d = await rt.total(() => authBudget.hit(conn.binding.userId), 'w_auth')
      if (!gate(conn, op)) return
      if (!stillAuthorizing(conn, k)) continue
      if (d === FAILED || d.outcome !== 'allowed') {
        deferKey(conn, op, k)
        const floor =
          d === FAILED
            ? 0
            : d.outcome === 'denied'
              ? d.resetMs - rt.wallNow()
              : KEY_CAP_RETRY_FLOOR_MS
        op.retryFloorMs = Math.max(op.retryFloorMs, floor)
      }
    }
    const toAuth = [...op.added].filter(k => stillAuthorizing(conn, k))
    if (toAuth.length > 0) {
      // One ancestry query for every key of the op.
      const res = await rt.total(async () => {
        const result = await deps.watchPool.query({
          text: GFS_WATCH_ANCESTRY_CTE,
          values: [rids(new Set(toAuth.map(rid)))],
          query_timeout: CTE_QUERY_TIMEOUT_MS,
        } as QueryConfig)
        if ((result.rows as { cycle?: unknown }[]).some(row => row.cycle === true)) {
          throw new Error('gfs_resources ancestry contains a cycle')
        }
        return result
      }, 'cte')
      if (!gate(conn, op)) return
      if (res === FAILED) {
        for (const k of toAuth) if (stillAuthorizing(conn, k)) deferKey(conn, op, k)
      } else {
        const chains = groupBy(
          res.rows as { requested_id?: unknown; ancestor_id?: unknown }[],
          row => toRid32(row.requested_id),
          row => toRid32(row.ancestor_id)
        )
        // Index before reading: a change that lands during the reads finds the key.
        for (const k of toAuth) {
          if (!stillAuthorizing(conn, k)) continue
          const c = chains.get(rid(k))
          if (c === undefined) {
            op.noChain.add(k)
            op.chains.set(k, [])
          } else op.chains.set(k, c)
          index(conn, k, op.chains.get(k)!)
        }
        // One read token per drive. The user mint revalidates the
        // opening session against the database, so every op proves it again.
        const drives = drivesOf(toAuth.filter(k => stillAuthorizing(conn, k)))
        for (const d of drives) {
          const t = await rt.total(
            () =>
              rt.raceAbort(
                mintReadToken(conn.authentication, conn.authority as ExternalGfsAuthority, d),
                op.signal
              ),
            'mint'
          )
          if (!gate(conn, op)) return
          if (t === null) {
            // Not terminal: the reopen authenticates again and its 401 decides.
            closeConn(conn, 'reauthorize')
            return
          }
          if (t === FAILED) {
            for (const k of toAuth) {
              if (keyDrive(k) === d && stillAuthorizing(conn, k)) deferKey(conn, op, k)
            }
            op.loadDeferred = true
          } else op.tokens.set(d, t.token)
        }
        // Reads to gfsc: 4 per op, 64 per process.
        const toRead = toAuth.filter(k => stillAuthorizing(conn, k))
        readSlots.demand += toRead.length
        await runLimited(
          toRead.map(k => () => readThunk(conn, op, k)),
          READ_PARALLELISM,
          (f, label) => rt.total(f, label)
        )
        if (!gate(conn, op)) return
      }
    }
    // Totality: no key leaves the op still authorizing.
    for (const k of op.added) if (stillAuthorizing(conn, k)) deferKey(conn, op, k)
    finishOp(conn, op)
  }

  async function readThunk(conn: WatchConnection, op: WatchOp, k: GfsKey): Promise<void> {
    try {
      if (op.signal.aborted || !gate(conn, op) || !stillAuthorizing(conn, k)) return
      const r = await rt.total<GfscReadResult, GfscReadResult>(
        async () => {
          await readSlots.acquire(op.signal)
          let v: GfscReadResult = GFSC_READ_TRANSIENT_NO_RESPONSE
          try {
            v = await readGfscFn(
              rid(k),
              op.tokens.get(keyDrive(k)) ?? '',
              op.opId,
              op.signal,
              GFS_WATCH_READ_TIMEOUT_MS
            )
            return v
          } finally {
            readSlots.release(v.responded)
          }
        },
        'gfsc-read',
        GFSC_READ_TRANSIENT_NO_RESPONSE
      )
      if (!gate(conn, op)) return
      if (!stillAuthorizing(conn, k)) return
      const rec = conn.keys.get(k)!
      switch (r.status) {
        case '2xx':
          if (kindOf(r.kind) !== keyKind(k)) {
            rec.state = 'rejected'
            unindex(conn, k)
          } else if (op.noChain.has(k)) {
            deferKey(conn, op, k)
          } else {
            rec.state = 'accepted'
          }
          return
        case 403:
          if (r.principalDenied) {
            // A denial of the principal is not a decision about this resource:
            // the reopen decides with the authority that is current then.
            closeConn(conn, 'reauthorize')
            return
          }
          rec.state = 'rejected'
          unindex(conn, k)
          return
        case 404:
        case 410:
          rec.state = 'rejected'
          unindex(conn, k)
          return
        case 401:
          // The token is refused, not the user: deferring would retry forever unseen.
          rt.log.error({ connId: conn.connId, opId: op.opId }, 'gfsc rejected watch read token')
          closeConn(conn, 'internal')
          return
        default:
          deferKey(conn, op, k)
          op.loadDeferred = true
      }
    } finally {
      readSlots.demand -= 1
    }
  }

  function onAuthDeadline(conn: WatchConnection, op: WatchOp): void {
    if (!gate(conn, op)) return
    for (const k of op.added) {
      if (stillAuthorizing(conn, k)) {
        deferKey(conn, op, k)
        op.loadDeferred = true
      }
    }
    // Aborts reads, queued read permits and the mint wait; the connection stays open.
    op.authCtl.abort()
  }

  function deferKey(conn: WatchConnection, op: WatchOp, k: GfsKey): void {
    unindex(conn, k)
    conn.keys.delete(k)
    conn.pending.delete(k)
    op.deferred.add(k)
  }

  function endOp(conn: WatchConnection, op: WatchOp): void {
    rt.cancel(op, 'tAuth', 'tSrv')
    opsInFlight.delete(conn)
    conn.op = null
  }

  function retryAfter(op: WatchOp): number {
    return Math.round(
      Math.max(MIN_RETRY_AFTER_MS, op.retryFloorMs, op.loadDeferred ? readSlots.backlogMs() : 0)
    )
  }

  function keysIn(conn: WatchConnection, state: KeyRec['state']): GfsKey[] {
    const out: GfsKey[] = []
    for (const [k, r] of conn.keys) if (r.state === state) out.push(k)
    return out
  }

  function finishOp(conn: WatchConnection, op: WatchOp): void {
    // A decision whose chain changed while the op ran may come from a
    // gfsc cache entry of before the change.
    for (const k of op.added) {
      if (conn.keys.get(k)?.state !== 'accepted') continue
      const chain = op.chains.get(k) ?? []
      if (op.dirtyOverflow || op.dirtyRids.has(rid(k)) || chain.some(a => op.dirtyRids.has(a))) {
        deferKey(conn, op, k)
        op.retryFloorMs = Math.max(op.retryFloorMs, SUSPECT_RETRY_FLOOR_MS)
      }
    }
    // A retained user gets no decision frame.
    if (retenida(conn)) {
      if (op.kind === 'open') closeConn(conn, 'reauthorize')
      else {
        conn.nextCmd = null
        endOp(conn, op)
      }
      return
    }
    const accepted = keysIn(conn, 'accepted')
    const rejected = keysIn(conn, 'rejected')
    const deferred = [...op.deferred]
    const retryAfterMs = deferred.length > 0 ? retryAfter(op) : undefined
    const decision = {
      accepted,
      rejected,
      deferred,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    }
    if (op.kind === 'open') {
      // The header and the ready are the only bytes written outside `send`,
      // and they go before `phase = 'ready'`, so no frame can overtake them.
      conn.socket.writeHead(200, STREAM_HEADERS)
      conn.socket.flushHeaders()
      conn.socket.write(
        ndjson({ schemaVersion: 1, type: 'ready', connId: conn.connId, heartbeatMs, ...decision })
      )
      gfsWatchFramesSentTotal.inc({ frame_type: 'ready' })
      conn.phase = 'ready'
      armExp(conn)
      armHeartbeat(conn)
      armLifetime(conn)
    } else {
      send(conn, { type: 'subscriptions', seq: op.seq, ...decision })
    }
    endOp(conn, op)
    // Next command. Guarded: a throw after its newOp must close the
    // connection, or the new op would stay registered without runOpSafe.
    const cmd = conn.nextCmd
    if (cmd) {
      conn.nextCmd = null
      rt.guarded(conn, () => startDelta(conn, cmd.seq, cmd.keys, cmd.r))
    }
  }

  // ─── Commands ────────────────────────────────────────────────────────────

  function onCmd(cmd: WatchCmd): void {
    const conn = byConnId.get(cmd.c)
    if (!conn) return
    if (
      normUid(cmd.u) !== conn.binding.userId ||
      positiveGeneration(cmd.g) !== conn.binding.authGeneration
    ) {
      gfsWatchCmdDroppedTotal.inc({ reason: 'binding_mismatch' })
      return
    }
    if (conn.phase !== 'ready') return
    if (cmd.s <= conn.lastSeq || cmd.s <= (conn.nextCmd?.seq ?? 0)) return
    if (cmd.s > conn.lastSeq + GFS_WATCH_SEQ_WINDOW) {
      gfsWatchCmdDroppedTotal.inc({ reason: 'seq_jump' })
      return
    }
    if (conn.op !== null) {
      conn.nextCmd = { seq: cmd.s, keys: cmd.keys, r: cmd.r }
      return
    }
    rt.guarded(conn, () => startDelta(conn, cmd.s, cmd.keys, cmd.r))
  }

  /** Synchronous: `lastSeq` moves before any await, so a retry of the same seq is dropped. */
  function startDelta(conn: WatchConnection, s: number, keys: ReadonlySet<GfsKey>, r: Uuid): void {
    if (s <= conn.lastSeq) return
    conn.lastSeq = s
    for (const k of [...conn.keys.keys()]) {
      if (keys.has(k)) continue
      unindex(conn, k)
      conn.keys.delete(k)
      conn.pending.delete(k)
    }
    const added = new Set([...keys].filter(k => !conn.keys.has(k)))
    const op = newOp(conn, 'delta', s, added, rt.now() + GFS_WATCH_DELTA_SERVER_DEADLINE_MS, r)
    for (const k of added) conn.keys.set(k, { state: 'authorizing', chain: null })
    void runOpSafe(conn, op)
  }

  // ─── Resource changes ────────────────────────────────────────────────────

  function onResourceChanged(change: ResourceChanged): void {
    const { rid32: x, oldParent, newParent, a, op } = change
    // Delivery: the resource's own keys, and the directory keys of both parents.
    const targets = new Map<WatchConnection, GfsKey[]>()
    const collect = (r: Rid32 | null, dirOnly: boolean) => {
      if (r === null) return
      for (const conn of byResource.get(r) ?? []) {
        for (const k of conn.keys.keys()) {
          if (rid(k) !== r || (dirOnly && keyKind(k) !== 'dir')) continue
          const list = targets.get(conn)
          if (list) list.push(k)
          else targets.set(conn, [k])
        }
      }
    }
    collect(x, false)
    collect(oldParent, true)
    if (newParent !== oldParent) collect(newParent, true)
    for (const [conn, ks] of targets) {
      rt.guarded(conn, () => {
        for (const k of ks) deliver(conn, k)
      })
    }
    // Every ancestry change while an op is in flight makes its decisions
    // over that rid suspect; the intersection with each chain is taken when the op finishes.
    if (a === 1 && op !== 'i') {
      recentDirty.push(x, rt.now())
      for (const conn of opsInFlight) {
        const o = conn.op
        if (!o) continue
        if (o.dirtyRids.size >= DIRTY_RIDS_CAP) o.dirtyOverflow = true
        else o.dirtyRids.add(x)
      }
    }
    // An ancestry change can revoke what a user was granted through the old
    // chain. Keys of the op in flight are left to the suspect marking above;
    // a rejected key is not indexed, and an operator's access does not
    // depend on the chain.
    if (a === 1) {
      let added = false
      const candidates = new Set([...(byResource.get(x) ?? []), ...(byAncestor.get(x) ?? [])])
      for (const conn of candidates) {
        if (conn.principalKind !== 'user' || reauthPending.conns.has(conn)) continue
        const inFlight = conn.op?.added
        for (const [k, r] of conn.keys) {
          if (r.state !== 'accepted' || inFlight?.has(k)) continue
          if (rid(k) === x || r.chain?.includes(x)) {
            reauthPending.conns.add(conn)
            added = true
            break
          }
        }
      }
      if (added) armAuthzWindow()
    }
    if (change.h === 1) onRootsHint(x, op)
  }

  // ─── Open ────────────────────────────────────────────────────────────────

  function reply(
    status: 400 | 401 | 429 | 503,
    code: string,
    retryAfterSec?: number
  ): WatchOpenOutcome {
    return retryAfterSec === undefined
      ? { kind: 'reply', status, code }
      : { kind: 'reply', status, code, retryAfterSec }
  }

  function replyFromClose(conn: WatchConnection): WatchOpenOutcome {
    if (conn.socket.headersSent || conn.closeReason === 'client_gone') return { kind: 'none' }
    const retryAfterSec =
      conn.closeRetryAfterMs === null
        ? DEFAULT_CLOSE_RETRY_AFTER_SEC
        : Math.ceil(conn.closeRetryAfterMs / 1000)
    if (conn.closeReason === 'session_expired') return reply(401, 'session_invalid')
    if (conn.closeReason === 'reauthorize') return reply(503, 'watch_reauthorize', retryAfterSec)
    return reply(503, 'watch_reopen', retryAfterSec)
  }

  /**
   * Admission, the open op and its outcome, after the HTTP handler has
   * authenticated the session and passed the open limiter. Never rejects.
   */
  async function open(input: WatchOpenInput): Promise<WatchOpenOutcome> {
    let conn: WatchConnection | null = null
    try {
      // The same ceilings the key parser enforces: the command that later
      // carries this set must fit one NOTIFY.
      if (input.keys.size > MAX_KEYS_PER_SET || drivesOf(input.keys).size > MAX_DRIVES_PER_SET) {
        return reply(400, 'bad_request')
      }
      const binding = watchBindingOf(input.authentication)
      if (binding === null) return reply(401, 'session_invalid')
      const uid = binding.userId
      if (!listener.state.listenerReady) {
        return reply(503, 'watch_listener_unavailable', DEFAULT_CLOSE_RETRY_AFTER_SEC)
      }
      if (
        byConnId.size >= GFS_WATCH_MAX_CONNECTIONS ||
        (admittedPerPrincipal.get(uid) ?? 0) >= GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL
      ) {
        return reply(429, 'admission_full', ADMISSION_RETRY_AFTER_SEC)
      }
      // Same answer the op's final gate would give, without spending the
      // authorization budget, the ancestry query and up to 64 reads.
      if (usuarioRetenido(uid)) {
        return reply(503, 'watch_reauthorize', DEFAULT_CLOSE_RETRY_AFTER_SEC)
      }
      const c: WatchConnection = {
        connId: randomBytes(16).toString('hex'),
        binding: { userId: uid, authGeneration: binding.authGeneration },
        // 'user' until the authority is known: fails closed.
        principalKind: 'user',
        authentication: input.authentication,
        exp: binding.exp,
        phase: 'opening',
        closeCtl: new AbortController(),
        closeReason: null,
        closeRetryAfterMs: null,
        authority: null,
        socket: input.socket,
        lastSeq: 0,
        keys: new Map(),
        resourceRefs: new Map(),
        ancestorRefs: new Map(),
        pending: new Set(),
        op: null,
        nextCmd: null,
        timers: {
          flush: null,
          exp: null,
          heartbeat: null,
          lifetime: null,
          rootsTrailing: null,
          drain: null,
        },
        rootsLastSentAt: Number.NEGATIVE_INFINITY,
      }
      conn = c
      byConnId.set(c.connId, c)
      admittedPerPrincipal.set(uid, (admittedPerPrincipal.get(uid) ?? 0) + 1)
      addToIndex(byUser, uid, c)
      gfsWatchConnectionsActive.inc({ principal_kind: c.principalKind })
      input.socket.onGone(() => rt.guarded(c, () => closeConn(c, 'client_gone')))
      const op = newOp(
        c,
        'open',
        0,
        new Set(input.keys),
        input.srvDeadline,
        input.requestId,
        input.watchSignal
      )
      for (const k of input.keys) c.keys.set(k, { state: 'authorizing', chain: null })

      // Revalidate after admission: a revocation committed between the
      // handler's authentication and the admission is seen here. On op.signal,
      // not authCtl: closing the connection aborts closeCtl, which is in it.
      const current = await rt.step(observeCurrentness(input.authentication), op.signal)
      if (!gate(c, op)) return replyFromClose(c)
      if ('aborted' in current && current.aborted) {
        closeConn(c, 'deadline')
        return reply(503, 'watch_reopen', DEFAULT_CLOSE_RETRY_AFTER_SEC)
      }
      if (!current.ok) {
        closeConn(c, 'internal')
        return { kind: 'classify', origin: 'session', error: (current as { error: unknown }).error }
      }
      if (current.value.status === 'unavailable') {
        closeConn(c, 'internal')
        return { kind: 'classify', origin: 'session', error: current.value.error }
      }
      if (current.value.status !== 'current') {
        closeConn(c, 'internal')
        return reply(401, 'session_invalid')
      }
      const resolved = await rt.step(resolveAuthority(input.authentication), op.signal)
      if (!gate(c, op)) return replyFromClose(c)
      if ('aborted' in resolved && resolved.aborted) {
        closeConn(c, 'deadline')
        return reply(503, 'watch_reopen', DEFAULT_CLOSE_RETRY_AFTER_SEC)
      }
      if (!resolved.ok) {
        closeConn(c, 'internal')
        return {
          kind: 'classify',
          origin: 'authority',
          error: (resolved as { error: unknown }).error,
        }
      }
      const pk = principalOf(resolved.value)
      if (pk === null) {
        rt.log.error({ connId: c.connId }, 'unknown gfs watch authority kind')
        closeConn(c, 'internal')
        return reply(503, 'watch_reopen', DEFAULT_CLOSE_RETRY_AFTER_SEC)
      }
      c.authority = resolved.value
      if (pk !== c.principalKind) {
        gfsWatchConnectionsActive.dec({ principal_kind: c.principalKind })
        gfsWatchConnectionsActive.inc({ principal_kind: pk })
        c.principalKind = pk
      }
      if (pk === 'linked_operator') linkedOperators.add(c)

      // Authorize the keys; emits `ready` or leaves the connection closed.
      await runOpSafe(c, op)
      if (c.phase === 'ready') return { kind: 'stream' }
      if (c.phase === 'closed') return replyFromClose(c)
      rt.log.error({ connId: c.connId }, 'gfs watch open ended without a decision')
      closeConn(c, 'internal')
      return replyFromClose(c)
    } catch (err) {
      rt.log.error({ err, connId: conn?.connId }, 'gfs watch open failed')
      if (conn) closeConn(conn, 'internal')
      return input.socket.headersSent
        ? { kind: 'none' }
        : reply(503, 'watch_reopen', DEFAULT_CLOSE_RETRY_AFTER_SEC)
    }
  }

  return {
    open,
    start: listener.startGfsWatchRegistry,
    stop: listener.stopGfsWatchRegistry,
    now: rt.now,
    heartbeatMs,
    listenerReady: () => listener.state.listenerReady,
    /** Retention primitives: a hold counts once per reason that registered it. */
    hold,
    unhold,
    /** Read-only views for invariant checks and the HTTP shell. */
    state: {
      byConnId: byConnId as ReadonlyMap<string, WatchConnection>,
      byUser: byUser as ReadonlyMap<Uuid, ReadonlySet<WatchConnection>>,
      byResource: byResource as ReadonlyMap<Rid32, ReadonlySet<WatchConnection>>,
      byAncestor: byAncestor as ReadonlyMap<Rid32, ReadonlySet<WatchConnection>>,
      opsInFlight: opsInFlight as ReadonlySet<WatchConnection>,
      holdUsers: holdUsers as ReadonlyMap<Uuid, number>,
      /** A snapshot of the authorization window and the fail-closed. */
      windows: () => ({
        ...windows,
        authzTeams: new Set(authzTeams),
        authzAdmins: new Set(authzAdmins),
        retryTeams: new Set(retryTeams),
        retryAdmins: new Set(retryAdmins),
        failClosedPending: new Set(failClosedPending),
        reauthUsers: new Set(reauthPending.users),
        reauthConns: new Set(reauthPending.conns),
        rootsPending: new Set(rootsPending),
        rootsRids: new Set(rootsRids),
        sessionPending: new Set(sessionPending),
        /** The users of each session confirmation awaiting its query. */
        sessionConfirming: [...sessionConfirming].map(s => new Set(s)),
        windowEpoch,
      }),
      readSlots,
      recentDirty,
      listener: listener.state,
    },
  }
}

export type GfsWatchRegistry = ReturnType<typeof createGfsWatchRegistry>
