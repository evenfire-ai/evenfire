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
  gfsWatchFramesSentTotal,
  gfsWatchKeyDeferredTotal,
} from '../../observability/metrics.js'
import { STREAM_HEADERS } from '../../routes/streamHeaders.js'
import {
  type ExternalSessionCurrentness,
  observeExternalSessionCurrentness,
} from '../auth/externalSessionCurrentnessObserver.js'
import {
  GFS_WATCH_MAX_CONNECTIONS,
  GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL,
} from './admissionLimits.js'
import {
  type GfsKey,
  MAX_DRIVES_PER_SET,
  MAX_KEYS_PER_SET,
  type Rid32,
  type Uuid,
  type WatchPrincipalKind,
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
import { type GfsWatchListenerDeps, createGfsWatchListener } from './listener.js'
import type { ResourceChanged, WatchCmd } from './notifySchemas.js'
import { type ReadSlots, createReadSlots, runLimited } from './readSlots.js'
import { type RecentDirty, createRecentDirty } from './recentDirty.js'
import { FAILED, type TimerHandle, type WatchClock, createWatchRuntime } from './runtime.js'

// ─── Limits and deadlines ─────────────────────────────────────────────────

export const GFS_WATCH_DEFAULT_HEARTBEAT_MS = 20_000
export const GFS_WATCH_DEFAULT_MAX_LIFETIME_MS = 120 * 60_000
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
  // Only at the open, before any frame: the revalidated session is not
  // current, or the session store reported an outage. Kept apart from
  // `internal` so a revocation or an outage is not counted as a defect. The
  // observer reports every outage as a status, so one that throws is a defect
  // and stays `internal`.
  | 'session_invalid'
  | 'session_unavailable'

/** Reasons the client is told about before the stream ends. */
const CLOSING_FRAME_REASONS: ReadonlySet<WatchCloseReason> = new Set([
  'listener_lost',
  'max_lifetime',
  'reauthorize',
  'session_expired',
  'server_shutdown',
])

/** Why an op left a key deferred; the label of gfs_watch_key_deferred_total. */
export type DeferCause =
  | 'auth_budget'
  | 'ancestry_failed'
  | 'mint_failed'
  | 'totality'
  | 'no_chain'
  | 'gfsc_transient'
  | 'auth_deadline'
  | 'suspect'

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
  maxConnections?: number
  maxConnectionsPerPrincipal?: number
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
  const maxConnections = deps.maxConnections ?? GFS_WATCH_MAX_CONNECTIONS
  const maxConnectionsPerPrincipal =
    deps.maxConnectionsPerPrincipal ?? GFS_WATCH_MAX_CONNECTIONS_PER_PRINCIPAL
  // A NaN cap makes both admission comparisons false and admits without limit.
  for (const [name, v] of [
    ['maxConnections', maxConnections],
    ['maxConnectionsPerPrincipal', maxConnectionsPerPrincipal],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new Error(`gfs watch ${name} must be a positive integer`)
    }
  }
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

  // Retention and the authorization/roots windows. Nothing here fills them
  // yet, but every reader (`connHeld`, the open's admission, `closeConn`)
  // already honours them, so a retained user can neither receive a decision
  // nor open a stream.
  const holdUsers = new Map<Uuid, number>()
  const reauthPending = { users: new Set<Uuid>(), conns: new Set<WatchConnection>() }
  const rootsPending = new Set<WatchConnection>()
  const linkedOperators = new Set<WatchConnection>()

  const listener = createGfsWatchListener<WatchConnection>({
    connectionString: deps.listenConnectionString,
    runtime: rt,
    recentDirty,
    connections: () => byConnId.values(),
    opsInFlight: () => opsInFlight,
    closeConn: (conn, reason, opts) => closeConn(conn, reason, opts),
    onCmd,
    onResourceChanged,
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

  function userHeld(uid: Uuid): boolean {
    return reauthPending.users.has(uid) || (holdUsers.get(uid) ?? 0) > 0
  }

  function connHeld(conn: WatchConnection): boolean {
    return reauthPending.conns.has(conn) || userHeld(conn.binding.userId)
  }

  function resetWindows(): void {
    // The authorization and session windows do not exist yet; the listener
    // already calls this on every process transition.
  }

  function onExpansionFailed(): void {
    // Without the authorization windows there is no expansion to fail; an
    // unreadable revocation hint is covered by the suspect marking the
    // listener applies before calling this.
  }

  // ─── Socket ──────────────────────────────────────────────────────────────

  /** The only writer after `ready`. Returns whether the frame was written. */
  function send(conn: WatchConnection, frame: WatchFrame, opts = { final: false }): boolean {
    if (conn.phase !== 'ready') return false
    if (frame.type === 'roots_changed' && connHeld(conn)) return false
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
    if (connHeld(conn)) {
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
      // One id format for log correlation across control-api and gfsc; gfsc
      // reads accept any header, mutations require a uuid.
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
        deferKey(conn, op, k, 'auth_budget')
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
        for (const k of toAuth)
          if (stillAuthorizing(conn, k)) deferKey(conn, op, k, 'ancestry_failed')
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
              if (keyDrive(k) === d && stillAuthorizing(conn, k)) {
                deferKey(conn, op, k, 'mint_failed')
              }
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
    for (const k of op.added) if (stillAuthorizing(conn, k)) deferKey(conn, op, k, 'totality')
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
      // Not observable today and kept on purpose: a close aborts op.signal, so
      // readGfsc answers transient and the default branch only defers a key of
      // a connection already gone. Without this gate, a read that resolved
      // with a real status after the close (a reader that does not honour the
      // abort, or a cached answer) would accept keys or log a refused token on
      // a closed connection.
      if (!gate(conn, op)) return
      if (!stillAuthorizing(conn, k)) return
      const rec = conn.keys.get(k)!
      switch (r.status) {
        case '2xx':
          if (kindOf(r.kind) !== keyKind(k)) {
            rec.state = 'rejected'
            unindex(conn, k)
          } else if (op.noChain.has(k)) {
            deferKey(conn, op, k, 'no_chain')
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
          rt.logSampledWarn(
            'deferred:gfsc_transient',
            { connId: conn.connId, opId: op.opId, httpStatus: r.httpStatus },
            'gfs watch key deferred on a transient gfsc read'
          )
          deferKey(conn, op, k, 'gfsc_transient')
          op.loadDeferred = true
      }
    } finally {
      readSlots.demand -= 1
    }
  }

  function onAuthDeadline(conn: WatchConnection, op: WatchOp): void {
    // Not observable today and kept on purpose: every path that ends or
    // replaces the op (endOp, closeConn) clears tAuth first, so this timer
    // cannot fire for a dead op. If a new path ever drops the op without
    // clearing it, this stops a stale deadline from deferring the keys of
    // the op that replaced it.
    if (!gate(conn, op)) return
    let deferred = 0
    for (const k of op.added) {
      if (stillAuthorizing(conn, k)) {
        deferKey(conn, op, k, 'auth_deadline')
        op.loadDeferred = true
        deferred += 1
      }
    }
    if (deferred > 0) {
      rt.logSampledWarn(
        'deferred:auth_deadline',
        { connId: conn.connId, opId: op.opId, deferred },
        'gfs watch op reached its authorization deadline'
      )
    }
    // Aborts reads, queued read permits and the mint wait; the connection stays open.
    op.authCtl.abort()
  }

  function deferKey(conn: WatchConnection, op: WatchOp, k: GfsKey, cause: DeferCause): void {
    unindex(conn, k)
    conn.keys.delete(k)
    conn.pending.delete(k)
    op.deferred.add(k)
    rt.bestEffort(() => gfsWatchKeyDeferredTotal.inc({ cause }))
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
        deferKey(conn, op, k, 'suspect')
        op.retryFloorMs = Math.max(op.retryFloorMs, SUSPECT_RETRY_FLOOR_MS)
      }
    }
    // A retained user gets no decision frame.
    if (connHeld(conn)) {
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
        byConnId.size >= maxConnections ||
        (admittedPerPrincipal.get(uid) ?? 0) >= maxConnectionsPerPrincipal
      ) {
        return reply(429, 'admission_full', ADMISSION_RETRY_AFTER_SEC)
      }
      // Same answer the op's final gate would give, without spending the
      // authorization budget, the ancestry query and up to 64 reads.
      if (userHeld(uid)) {
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
        // Not an outage: those come back as status 'unavailable' below.
        closeConn(c, 'internal')
        return { kind: 'classify', origin: 'session', error: (current as { error: unknown }).error }
      }
      if (current.value.status === 'unavailable') {
        closeConn(c, 'session_unavailable')
        return { kind: 'classify', origin: 'session', error: current.value.error }
      }
      if (current.value.status !== 'current') {
        closeConn(c, 'session_invalid')
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
      readSlots,
      recentDirty,
      listener: listener.state,
    },
  }
}

export type GfsWatchRegistry = ReturnType<typeof createGfsWatchRegistry>
