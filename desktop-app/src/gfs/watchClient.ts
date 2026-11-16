import { ApiError, requestJson } from '../httpClient.js'
import type { GfsWatchEvent } from '../types.js'
import {
  BACKOFF_CAP_MS,
  DEFERRED_RETRY_CAP_MS,
  FIRST_FAILURE_SPREAD_MS,
  GFS_WATCH_PATH,
  type GfsWatchBinding,
  type GfsWatchFrame,
  HEARTBEAT_MAX_MS,
  HEARTBEAT_MIN_MS,
  MAX_FRAME_CHARS,
  PUT_MAX_ATTEMPTS,
  PUT_TRANSPORT_TIMEOUT_MS,
  SLOW_BACKOFF_MS,
  T_ACK_MS,
  T_OPEN_MS,
  T_PUT_MS,
  WATCHDOG_HEARTBEATS,
  bindingChanged,
  bindingOf,
  canonList,
  errorCodeOf,
  fuse,
  normUid,
  parseFrameLine,
  parseRetryAfterMs,
  withinSetCeilings,
} from './watchProtocol.js'
import { gfsWatchTransportDefaults } from './watchTransportDefaults.js'

/**
 * The GFS watch client of the main process: one long-lived NDJSON stream per
 * process whose key set changes in place with PUTs, fed by the merged lists
 * of every renderer (owner) and delivering change, access and session events
 * back to all of them.
 *
 * Every transition is synchronous. Each await (the GET, every `read()`, every
 * PUT) resolves into a handler that first checks it still belongs to the
 * current link (`g`) or PUT attempt (`id`), so a late result of an older
 * attempt is dropped instead of being applied to the new state. Every timer
 * clears its own handle on its first line, and every cancellation is
 * clear-and-null, so a stored handle is non-null exactly while it is pending.
 */

export type { GfsWatchEvent }

/** A renderer that receives watch events; wired by the IPC layer to a `webContents`. */
export interface GfsWatchOwner {
  readonly id: number
  isDestroyed(): boolean
  /** The current document's main-frame token, or null when Electron cannot read it. */
  mainFrameToken(): string | null
  send(event: GfsWatchEvent): void
}

export interface GfsWatchClock {
  /** Wall-clock milliseconds; an HTTP-date `Retry-After` is measured against it. */
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GfsWatchLogger {
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

type PutTransport = (
  method: 'PUT',
  url: string,
  options: { token?: string; body: unknown; signal: AbortSignal; timeoutMs: number }
) => Promise<unknown>

export type GfsWatchClientDeps = {
  /** External REST API base URL; read on every request because an environment switch changes it. */
  baseUrl: () => string
  /** The GET. Raw on purpose: `withTimeout` would stay armed for the whole body and kill a healthy stream. */
  fetch?: typeof fetch
  /** The PUT; the real `requestJson`, called without `retryTransientOnce`. */
  requestJson?: PutTransport
  clock?: GfsWatchClock
  random?: () => number
  log?: GfsWatchLogger
  /** Depth of the transient team hop, read live from the app service. */
  readHopDepth: () => number
  /** Asks `/me` whether the session really ended; called on every `sessionExpired` emitted. */
  onSessionExpiredVerdict: () => unknown
}

type Reader = ReadableStreamDefaultReader<Uint8Array>
type Timer = unknown

type Idle = { kind: 'Idle' }
type Backoff = { kind: 'Backoff'; timer: Timer | null }
type Opening = {
  kind: 'Opening'
  g: number
  ctl: AbortController
  tOpen: Timer | null
  tokenGeneration: number
  stream: Reader | null
}
type Ready = {
  kind: 'Ready'
  g: number
  ctl: AbortController
  stream: Reader
  connId: string
  tokenGeneration: number
  heartbeatMs: number
  watchdog: Timer | null
  accepted: Set<string>
  rejected: Set<string>
  deferred: Set<string>
  deferredRetryAfterMs: number | undefined
  ackedKeys: Set<string>
  appliedSeq: number
}
type Link = Idle | Backoff | Opening | Ready
type CloseMode = 'backoff' | 'slow' | 'reopen' | 'halt'

type PutAttempt = { id: number; ctl: AbortController }
type Put = {
  g: number
  connId: string
  seq: number
  keys: Set<string>
  tokenGeneration: number
  phase: 'sending' | 'acked' | 'retry'
  attempt: PutAttempt | null
  tPut: Timer | null
  tAck: Timer | null
  retryTimer: Timer | null
}

type OwnerRec = {
  handle: GfsWatchOwner
  /** null after a renderer crash until the next navigation: every IPC is refused meanwhile. */
  frameToken: string | null
  regOrder: number
  keys: string[]
}

type Session = { token: string | null; generation: number; binding: GfsWatchBinding | null }

/** A read-only view of the state, for tests and diagnostics. */
export type GfsWatchInspection = {
  link: Readonly<Link>
  put: Readonly<Put> | null
  sent: readonly string[]
  desired: readonly string[]
  emptyUntilChange: boolean
  poisonedPut: ReadonlySet<string> | null
  session: Readonly<Session> | null
  envSwitching: boolean
  latch: Readonly<{ generation: number; deferred: boolean }> | null
  unsupportedGeneration: number | null
  epoch: number
  openAttempt: number
  degraded: boolean
  refreshAccessOnReady: boolean
  putAttempt: number
  deferredTimer: Timer | null
  deferredAttempt: number
  seq: number
  owners: ReadonlyMap<number, Readonly<Omit<OwnerRec, 'handle'>>>
}

const realClock: GfsWatchClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function errorSummary(err: unknown): Record<string, unknown> {
  // Only the class and a bounded message: an error may echo a URL or a body.
  if (err instanceof Error) return { err: err.name, message: err.message.slice(0, 200) }
  return { err: typeof err }
}

const consoleLog: GfsWatchLogger = {
  warn: (message, meta) => console.warn(`[GfsWatch] ${message}`, meta ?? {}),
  error: (message, meta) => console.error(`[GfsWatch] ${message}`, meta ?? {}),
}

const isThenable = (x: unknown): x is PromiseLike<unknown> =>
  !!x &&
  (typeof x === 'object' || typeof x === 'function') &&
  typeof (x as { then?: unknown }).then === 'function'

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])
const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every(x => b.has(x))
const minus = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].filter(x => !b.has(x))
const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>) => [...a].some(x => b.has(x))

export type GfsWatchClient = ReturnType<typeof createGfsWatchClient>

export function createGfsWatchClient(deps: GfsWatchClientDeps) {
  const fallback = gfsWatchTransportDefaults()
  const doFetch = deps.fetch ?? fallback.fetch ?? ((input, init) => fetch(input, init))
  const putJson: PutTransport = deps.requestJson ?? ((m, url, o) => requestJson<unknown>(m, url, o))
  const clock = deps.clock ?? realClock
  const random = deps.random ?? Math.random
  const log = deps.log ?? consoleLog

  // ─── State ─────────────────────────────────────────────────────────────────
  // Per process: owners, regCounter, epoch, attemptCounter.
  // Per session (reset by resetSessionState): openAttempt, degraded, refreshAccessOnReady,
  //   unsupportedGeneration, and latch/session themselves.
  // Per link (released by closeLink or reset by the ready): put, putAttempt, deferredTimer,
  //   deferredAttempt, seq, poisonedPut.
  const owners = new Map<number, OwnerRec>()
  let regCounter = 0
  let desired: string[] = []
  let lastFused: string[] = []
  let sent: string[] = []
  let emptyUntilChange = false
  let poisonedPut: Set<string> | null = null
  let session: Session | null = null
  let envSwitching = false
  let latch: { generation: number; deferred: boolean } | null = null
  let unsupportedGeneration: number | null = null
  let epoch = 0
  let openAttempt = 0
  let degraded: { rejectedSent: Set<string> } | null = null
  let refreshAccessOnReady = false
  let link: Link = { kind: 'Idle' }
  let put: Put | null = null
  let putAttempt = 0
  let attemptCounter = 0
  let deferredTimer: Timer | null = null
  let deferredAttempt = 0
  let seq = 0
  let disposed = false

  // ─── Infrastructure ────────────────────────────────────────────────────────

  /** Runs an effect whose failure must not interrupt the transition around it, sync or async. */
  function bestEffort(effect: () => unknown): void {
    const onError = (err: unknown) => log.warn('watch effect failed', errorSummary(err))
    try {
      const result = effect()
      if (isThenable(result)) result.then(undefined, onError)
    } catch (err) {
      onError(err)
    }
  }

  /** Entry points never throw into their caller (IPC handlers, login, timers). */
  function guarded<T>(label: string, fallback: T, fn: () => T): T {
    if (disposed) return fallback
    try {
      return fn()
    } catch (err) {
      log.error('watch entry point failed', { entry: label, ...errorSummary(err) })
      return fallback
    }
  }

  function timer(ms: number, fn: () => void): Timer {
    return clock.setTimeout(() => guarded('timer', undefined, fn), ms)
  }

  function clear(handle: Timer | null | undefined): void {
    if (handle != null) bestEffort(() => clock.clearTimeout(handle))
  }

  const uniform = (lo: number, hi: number) => lo + random() * (hi - lo)
  /** Additive, so it never fires before a server's `Retry-After`. */
  const jitter = (x: number) => x + uniform(0, 0.2 * x)

  function delay(retryAfterMs: number | undefined, base: number): number {
    // The first failure after a ready or an open spreads a common outage (EOF,
    // 502 of a rollout) over 5 s; a server Retry-After already carries its spread.
    if (openAttempt === 1 && retryAfterMs === undefined)
      return base + uniform(0, FIRST_FAILURE_SPREAD_MS)
    return jitter(Math.max(retryAfterMs ?? 0, base))
  }

  const watchUrl = () => `${deps.baseUrl().replace(/\/+$/, '')}${GFS_WATCH_PATH}`

  function hopDepth(): number {
    try {
      return deps.readHopDepth()
    } catch (err) {
      log.warn('watch hop depth unreadable', errorSummary(err))
      return 0
    }
  }

  function emit(event: GfsWatchEvent): void {
    for (const owner of owners.values()) {
      // Without a frame token the window has no accepted document (after a
      // renderer crash, until the next navigation): an event sent now would land
      // in whatever document loads next. That document asks for the session
      // state in its first setSubscriptions, so nothing is lost by skipping it.
      if (owner.frameToken === null) continue
      try {
        if (owner.handle.isDestroyed()) continue
        owner.handle.send(event)
      } catch (err) {
        log.warn('watch event delivery failed', { owner: owner.handle.id, ...errorSummary(err) })
      }
    }
  }

  const emitKeys = (type: 'resync' | 'rejected' | 'changed', keys: Iterable<string>) => {
    const list = [...keys]
    if (list.length > 0) emit({ type, keys: list })
  }

  const hasNewerCommittedSession = (generation: number) =>
    !!session?.token && session.generation > generation

  const isLive = (g: number) => (link.kind === 'Opening' || link.kind === 'Ready') && link.g === g

  // ─── Link transitions ──────────────────────────────────────────────────────

  /** The only sender of a GET. */
  function ensureOpen(): void {
    if (link.kind !== 'Idle') return
    if (!session?.token || envSwitching) return
    if (latch && latch.generation >= session.generation) return
    if (unsupportedGeneration !== null && unsupportedGeneration >= session.generation) return
    const g = ++epoch
    const opening: Opening = {
      kind: 'Opening',
      g,
      ctl: new AbortController(),
      tOpen: null,
      tokenGeneration: session.generation,
      stream: null,
    }
    link = opening
    // A roots change during any open cannot be written (the server only sends
    // on a ready connection), so every ready, the first one included, refreshes.
    refreshAccessOnReady = true
    opening.tOpen = timer(T_OPEN_MS, () => onOpenFail(opening))
    const keys = [...sent]
    const token = session.token
    bestEffort(() => {
      const url = new URL(watchUrl())
      for (const k of keys) url.searchParams.append('k', k)
      return (
        doFetch(url, {
          method: 'GET',
          headers: { accept: 'application/x-ndjson', authorization: `Bearer ${token}` },
          signal: opening.ctl.signal,
          // A followed redirect would carry the session token to another origin.
          redirect: 'error',
        })
          .then(res => onGetResponse(g, res))
          // Also catches a throw of onGetResponse, so no answer leaves the link Opening.
          .catch(err => onGetError(g, err))
      )
    })
  }

  function onOpenFail(opening: Opening): void {
    opening.tOpen = null
    if (link !== opening) return
    closeLink('open_timeout', 'backoff')
  }

  function onGetResponse(g: number, res: Response): void {
    if (!(link.kind === 'Opening' && link.g === g)) {
      bestEffort(() => res.body?.cancel())
      return
    }
    const opening = link
    if (res.status < 200 || res.status > 299) {
      const code = errorCodeOf({ header: res.headers.get('x-watch-error') })
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), clock.now())
      bestEffort(() => res.body?.cancel())
      onOpenError(opening, res.status, code, retryAfterMs)
      return
    }
    if (!res.body) {
      log.warn('watch open answered without a body', { status: res.status })
      closeLink('transient', 'backoff')
      return
    }
    const reader = res.body.getReader()
    opening.stream = reader
    bestEffort(() => readLoop(g, reader))
  }

  function onGetError(g: number, err: unknown): void {
    if (link.kind === 'Opening' && link.g === g) {
      if (!isAbort(err)) log.warn('watch open failed', errorSummary(err))
      closeLink('transient', 'backoff')
    } else if (link.kind === 'Ready' && link.g === g) {
      onStreamError(g)
    }
  }

  const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError'

  /** Every status lands in exactly one row; a null code falls in the "other" row of its status. */
  function onOpenError(
    opening: Opening,
    status: number,
    code: string | null,
    retryAfterMs: number | undefined
  ): void {
    if (status === 400) {
      log.error('watch open rejected the key set', { keys: sent.length })
      emptyUntilChange = true
      sent = []
      closeLink('bad_request', 'backoff')
    } else if (status === 401) {
      if (hasNewerCommittedSession(opening.tokenGeneration)) closeLink('stale', 'reopen')
      else terminal(opening.tokenGeneration)
    } else if (status === 403 && code === 'desktop_user_retired') {
      terminal(opening.tokenGeneration)
    } else if (
      (status === 426 && code === 'upgrade_required') ||
      (status === 409 && code === 'session_contract_unsupported')
    ) {
      unsupported(opening.tokenGeneration, code)
    } else if (status === 403) {
      if (degraded === null) {
        degraded = { rejectedSent: new Set() }
        emit({ type: 'accessChanged' })
      }
      const newlyRejected = minus(sent, degraded.rejectedSent)
      for (const k of newlyRejected) degraded.rejectedSent.add(k)
      emitKeys('rejected', newlyRejected)
      closeLink('forbidden', 'slow')
    } else if (status === 503 && code === 'watch_reauthorize') {
      emit({ type: 'accessChanged' })
      closeLink('reauthorize', 'backoff', retryAfterMs)
    } else {
      closeLink('transient', 'backoff', retryAfterMs)
    }
  }

  /** The only reader of the stream. */
  async function readLoop(g: number, reader: Reader): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        guarded('stream', undefined, () => onStreamError(g))
        return
      }
      const stop = guarded('stream', true, () => {
        if (!isLive(g)) return true
        if (chunk.done) {
          // A residue without its newline is a cut frame: it is dropped, not parsed.
          onStreamError(g)
          return true
        }
        // A multibyte character split across chunks must not be corrupted.
        buffer += decoder.decode(chunk.value, { stream: true })
        for (let nl = buffer.indexOf('\n'); nl !== -1; nl = buffer.indexOf('\n')) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.trim() === '') continue
          try {
            onLine(g, line)
          } catch (err) {
            // A throwing frame handler must not leave the link Ready without a reader.
            log.warn('watch frame handler failed', errorSummary(err))
            onStreamError(g)
            return true
          }
          if (!isLive(g)) return true
        }
        if (buffer.length > MAX_FRAME_CHARS) {
          onStreamError(g)
          return true
        }
        return false
      })
      if (stop) return
    }
  }

  function onLine(g: number, line: string): void {
    const parsed = parseFrameLine(line)
    if (parsed.kind === 'invalid') {
      onStreamError(g)
      return
    }
    // Unknown type or schema version: ignored, and it does not feed the watchdog.
    if (parsed.kind === 'unknown') return
    const frame = parsed.frame
    if (link.kind === 'Opening') {
      // Before the ready, any other known frame means a broken or mixed stream.
      if (frame.type === 'ready') onReady(link, frame)
      else closeLink('transient', 'backoff')
      return
    }
    if (link.kind !== 'Ready') return
    onReadyFrame(link, frame)
  }

  function onReadyFrame(ready: Ready, frame: GfsWatchFrame): void {
    switch (frame.type) {
      case 'ready':
        onStreamError(ready.g)
        return
      case 'subscriptions':
        onSubscriptions(ready, frame)
        return
      case 'changed':
        emitKeys('changed', frame.keys)
        return
      case 'roots_changed':
        emit({ type: 'accessChangedRoots' })
        return
      case 'heartbeat':
        armWatchdog(ready)
        return
      case 'stream.closing':
        onClosing(ready, frame.reason, frame.retryAfterMs)
        return
    }
  }

  function onStreamError(g: number): void {
    if (!isLive(g)) return
    if (link.kind === 'Opening') closeLink('transient', 'backoff')
    else closeLink('network', 'backoff')
  }

  /**
   * Synchronous and never throws. The state is released first and every
   * effect then runs in isolation: a failing abort or cancel can no longer
   * leave the link half-closed with a PUT in flight and no timer.
   */
  function closeLink(_cause: string, mode: CloseMode, retryAfterMs?: number): void {
    const oldLink = link
    const oldPut = put
    const oldDeferred = deferredTimer
    put = null
    putAttempt = 0
    deferredTimer = null
    deferredAttempt = 0
    link = { kind: 'Idle' }

    if (oldLink.kind === 'Opening' || oldLink.kind === 'Ready') {
      const live = oldLink
      bestEffort(() => live.ctl.abort())
      // After the abort, cancel() returns a rejected promise; bestEffort consumes it.
      bestEffort(() => live.stream?.cancel())
    }
    if (oldLink.kind === 'Opening') {
      clear(oldLink.tOpen)
      oldLink.tOpen = null
    } else if (oldLink.kind === 'Ready') {
      clear(oldLink.watchdog)
      oldLink.watchdog = null
    } else if (oldLink.kind === 'Backoff') {
      clear(oldLink.timer)
      oldLink.timer = null
    }
    if (oldPut) {
      clear(oldPut.tPut)
      clear(oldPut.tAck)
      clear(oldPut.retryTimer)
      oldPut.tPut = oldPut.tAck = oldPut.retryTimer = null
      const attempt = oldPut.attempt
      bestEffort(() => attempt?.ctl.abort())
    }
    clear(oldDeferred)

    switch (mode) {
      case 'reopen':
        ensureOpen()
        return
      case 'halt':
        return
      case 'slow':
        openAttempt += 1
        armBackoff(delay(retryAfterMs, SLOW_BACKOFF_MS))
        return
      default:
        // Any other mode is a backoff: no mode may leave the link Idle with a session.
        openAttempt += 1
        armBackoff(delay(retryAfterMs, Math.min(BACKOFF_CAP_MS, 1_000 * 2 ** (openAttempt - 1))))
    }
  }

  function armBackoff(ms: number): void {
    const backoff: Backoff = { kind: 'Backoff', timer: null }
    link = backoff
    backoff.timer = timer(ms, () => onBackoffTimer(backoff))
  }

  function onBackoffTimer(backoff: Backoff): void {
    backoff.timer = null
    if (link !== backoff) return
    link = { kind: 'Idle' }
    ensureOpen()
  }

  function armWatchdog(ready: Ready): void {
    clear(ready.watchdog)
    ready.watchdog = timer(WATCHDOG_HEARTBEATS * ready.heartbeatMs, () => onWatchdog(ready))
  }

  function onWatchdog(ready: Ready): void {
    ready.watchdog = null
    if (link !== ready) return
    closeLink('watchdog', 'backoff')
  }

  // ─── Frames ────────────────────────────────────────────────────────────────

  function onReady(opening: Opening, f: Extract<GfsWatchFrame, { type: 'ready' }>): void {
    if (f.heartbeatMs < HEARTBEAT_MIN_MS || f.heartbeatMs > HEARTBEAT_MAX_MS) {
      closeLink('transient', 'backoff')
      return
    }
    clear(opening.tOpen)
    opening.tOpen = null
    const accepted = new Set(f.accepted)
    const rejected = new Set(f.rejected)
    const deferred = new Set(f.deferred)
    const ready: Ready = {
      kind: 'Ready',
      g: opening.g,
      ctl: opening.ctl,
      stream: opening.stream as Reader,
      connId: f.connId,
      tokenGeneration: opening.tokenGeneration,
      heartbeatMs: f.heartbeatMs,
      watchdog: null,
      accepted,
      rejected,
      deferred,
      deferredRetryAfterMs: f.retryAfterMs,
      ackedKeys: new Set([...accepted, ...rejected]),
      appliedSeq: 0,
    }
    link = ready
    // The new connection's lastSeq is 0: an old seq would fall outside the
    // server's window and every PUT would time out into a reopen loop.
    seq = 0
    // The 400 belonged to another link, and this ready already applied `sent`
    // by GET; keeping it would stop a deferred key of this ready from retrying.
    poisonedPut = null
    openAttempt = 0
    degraded = null
    armWatchdog(ready)
    emitKeys('resync', [...accepted, ...deferred])
    emitKeys('rejected', rejected)
    if (refreshAccessOnReady) {
      refreshAccessOnReady = false
      emit({ type: 'accessChanged' })
    }
    if (intersects(deferred, new Set(sent))) armDeferredTimer(f.retryAfterMs)
    maybeSendPut()
  }

  function onSubscriptions(
    ready: Ready,
    f: Extract<GfsWatchFrame, { type: 'subscriptions' }>
  ): void {
    // Hardening: the server writes these in seq order on one connection and
    // drops a command whose seq it already applied, and a new connection is a
    // new Ready at 0. The guard keeps a replayed or reordered frame from
    // rolling `accepted` back to an older decision and re-emitting resync or
    // rejected for keys a newer decision already settled.
    if (f.seq <= ready.appliedSeq) return
    const accepted = new Set(f.accepted)
    const rejected = new Set(f.rejected)
    const deferred = new Set(f.deferred)
    emitKeys('resync', [...minus(accepted, ready.accepted), ...deferred])
    emitKeys('rejected', minus(rejected, ready.rejected))
    ready.accepted = accepted
    ready.rejected = rejected
    ready.deferred = deferred
    ready.ackedKeys = new Set([...accepted, ...rejected])
    ready.deferredRetryAfterMs = f.retryAfterMs
    ready.appliedSeq = f.seq
    if (put && f.seq >= put.seq) {
      // The command was applied: aborting its request is harmless and keeps a
      // single PUT in flight.
      const done = put
      const attempt = done.attempt
      bestEffort(() => attempt?.ctl.abort())
      clear(done.tPut)
      clear(done.tAck)
      clear(done.retryTimer)
      done.tPut = done.tAck = done.retryTimer = null
      done.attempt = null
      put = null
      putAttempt = 0
    }
    if (deferred.size === 0) {
      clear(deferredTimer)
      deferredTimer = null
      deferredAttempt = 0
    } else {
      armDeferredTimer(f.retryAfterMs)
    }
    maybeSendPut()
  }

  function onClosing(ready: Ready, reason: string, retryAfterMs: number | undefined): void {
    switch (reason) {
      case 'reauthorize':
        emit({ type: 'accessChanged' })
        closeLink('reauthorize', 'backoff', retryAfterMs)
        return
      case 'session_expired':
        if (hasNewerCommittedSession(ready.tokenGeneration)) closeLink('stale', 'reopen')
        else terminal(ready.tokenGeneration)
        return
      default:
        // listener_lost, max_lifetime, server_shutdown and any future reason:
        // reopen with the server's spread; the next ready refreshes access.
        closeLink(reason, 'backoff', retryAfterMs)
    }
  }

  // ─── PUT ───────────────────────────────────────────────────────────────────

  /** The only gate of the PUT. */
  function maybeSendPut(opts: { deferredOnly: boolean } = { deferredOnly: false }): void {
    if (link.kind !== 'Ready' || put !== null) return
    const ready = link
    const target = new Set(sent)
    if (poisonedPut && sameSet(target, poisonedPut)) return
    const missing = [...target].some(k => !ready.ackedKeys.has(k) && !ready.deferred.has(k))
    const extra = [...ready.ackedKeys].some(k => !target.has(k))
    const retryDeferred = opts.deferredOnly && intersects(ready.deferred, target)
    if (missing || extra || retryDeferred) {
      sendPut(ready)
      return
    }
    // Not sending: a deferred key still in `sent` needs someone to retry it.
    if (intersects(ready.deferred, target) && deferredTimer === null) {
      armDeferredTimer(ready.deferredRetryAfterMs)
    }
  }

  function armDeferredTimer(retryAfterMs: number | undefined): void {
    if (deferredTimer !== null) return
    deferredAttempt += 1
    const base = 1_000 * 2 ** (deferredAttempt - 1)
    deferredTimer = timer(
      jitter(Math.min(DEFERRED_RETRY_CAP_MS, Math.max(retryAfterMs ?? 0, base))),
      onDeferredTimer
    )
  }

  function onDeferredTimer(): void {
    deferredTimer = null
    maybeSendPut({ deferredOnly: true })
  }

  function sendPut(ready: Ready): void {
    seq += 1
    put = {
      g: ready.g,
      connId: ready.connId,
      seq,
      keys: new Set(sent),
      tokenGeneration: session?.generation ?? 0,
      phase: 'sending',
      attempt: null,
      tPut: null,
      tAck: null,
      retryTimer: null,
    }
    poisonedPut = null
    attemptPut(put)
  }

  /** One HTTP attempt; the only sender of the request. */
  function attemptPut(p: Put): void {
    const attempt: PutAttempt = { id: ++attemptCounter, ctl: new AbortController() }
    p.attempt = attempt
    p.phase = 'sending'
    p.tPut = timer(T_PUT_MS, () => onPutTimeout(p, attempt.id))
    const token = session?.token ?? undefined
    bestEffort(() =>
      putJson('PUT', watchUrl(), {
        ...(token ? { token } : {}),
        body: { connId: p.connId, seq: p.seq, keys: [...p.keys] },
        signal: attempt.ctl.signal,
        timeoutMs: PUT_TRANSPORT_TIMEOUT_MS,
      }).then(
        () => guarded('put', undefined, () => onPutResponse(p, attempt.id, { ok: true })),
        error => guarded('put', undefined, () => onPutResponse(p, attempt.id, { ok: false, error }))
      )
    )
  }

  const isCurrentAttempt = (p: Put, id: number) =>
    put === p &&
    p.phase === 'sending' &&
    p.attempt?.id === id &&
    link.kind === 'Ready' &&
    link.g === p.g

  function onPutTimeout(p: Put, id: number): void {
    p.tPut = null
    if (!isCurrentAttempt(p, id)) return
    const attempt = p.attempt
    p.attempt = null
    // Its rejection arrives with an id that no longer matches.
    bestEffort(() => attempt?.ctl.abort())
    scheduleRetry(p)
  }

  function scheduleRetry(p: Put, retryAfterMs?: number): void {
    putAttempt += 1
    p.phase = 'retry'
    clear(p.retryTimer)
    const base = Math.min(BACKOFF_CAP_MS, 1_000 * 2 ** (putAttempt - 1))
    p.retryTimer = timer(jitter(Math.max(retryAfterMs ?? 0, base)), () => resend(p))
  }

  /** Same seq and keys, unless `sent` changed: the PUT is declarative. */
  function resend(p: Put): void {
    p.retryTimer = null
    if (put !== p || p.phase !== 'retry' || link.kind !== 'Ready' || link.g !== p.g) return
    // Checked before the changed-set branch: if `sent` changes before every
    // retry, that branch would always be taken and the ceiling never reached.
    if (putAttempt > PUT_MAX_ATTEMPTS) {
      closeLink('put_exhausted', 'backoff')
      return
    }
    if (!sameSet(new Set(sent), p.keys)) {
      put = null
      maybeSendPut()
      // No new PUT: the episode ended, and the next one starts from the base backoff.
      if (put === null) putAttempt = 0
      return
    }
    attemptPut(p)
  }

  function onPutResponse(
    p: Put,
    id: number,
    r: { ok: true } | { ok: false; error: unknown }
  ): void {
    if (!isCurrentAttempt(p, id)) return
    clear(p.tPut)
    p.tPut = null
    p.attempt = null
    // requestJson exposes no 2xx status and throws SyntaxError only from
    // parsing a 2xx body, so a SyntaxError is a 2xx with a non-JSON body.
    if (r.ok || r.error instanceof SyntaxError) {
      p.phase = 'acked'
      p.tAck = timer(T_ACK_MS, () => onAckTimeout(p))
      return
    }
    const err = r.error
    const status = err instanceof ApiError ? err.status : null
    const code = err instanceof ApiError ? errorCodeOf({ bodyText: err.bodyText }) : null
    if (status === 400) {
      log.error('watch PUT rejected the key set', { keys: p.keys.size })
      poisonedPut = p.keys
      put = null
      putAttempt = 0
      maybeSendPut()
    } else if (status === 401) {
      if (hasNewerCommittedSession(p.tokenGeneration)) {
        put = null
        putAttempt = 0
        maybeSendPut()
      } else {
        terminal(p.tokenGeneration)
      }
    } else if (status === 403 && code === 'desktop_user_retired') {
      terminal(p.tokenGeneration)
    } else if (
      (status === 426 && code === 'upgrade_required') ||
      (status === 409 && code === 'session_contract_unsupported')
    ) {
      unsupported(p.tokenGeneration, code)
    } else if (status === 403) {
      closeLink('forbidden', 'slow')
    } else {
      // requestJson hands Retry-After over as the raw header string.
      const raw = err instanceof ApiError ? err.retryAfter : undefined
      scheduleRetry(p, parseRetryAfterMs(raw, clock.now()))
    }
  }

  function onAckTimeout(p: Put): void {
    p.tAck = null
    if (put !== p || p.phase !== 'acked' || link.kind !== 'Ready' || link.g !== p.g) return
    closeLink('ack_timeout', 'backoff')
  }

  // ─── Session end ───────────────────────────────────────────────────────────

  function terminal(generation: number): void {
    closeLink('terminal', 'halt')
    latch = { generation, deferred: hopDepth() > 0 }
    if (!latch.deferred) emitSessionExpired()
  }

  function emitSessionExpired(): void {
    emit({ type: 'sessionExpired' })
    bestEffort(() => deps.onSessionExpiredVerdict())
  }

  /**
   * The server supports neither this session nor this client: no retry until
   * another token. An answer for a token older than the session reopens with
   * the current one instead, as a 401 does: halting on it would leave the
   * link Idle with no event left to open it.
   */
  function unsupported(generation: number, code: string | null): void {
    if (hasNewerCommittedSession(generation)) {
      closeLink('stale', 'reopen')
      return
    }
    log.error('watch session unsupported', { code })
    closeLink('unsupported', 'halt')
    unsupportedGeneration = generation
  }

  // ─── Owners and the sent set ───────────────────────────────────────────────

  /** Owners stay registered: they still receive session and access events. */
  function clearOwnerLists(): void {
    for (const owner of owners.values()) owner.keys = []
    desired = []
    lastFused = []
    sent = []
    emptyUntilChange = false
    poisonedPut = null
  }

  /** Backoff, degradation and pending notices of one session are not carried into the next. */
  function resetSessionState(): void {
    openAttempt = 0
    degraded = null
    refreshAccessOnReady = false
    deferredAttempt = 0
    putAttempt = 0
    unsupportedGeneration = null
  }

  function recompute(): void {
    desired = fuse(owners.values())
    const fused = withinSetCeilings(desired)
    // Against the previous merge, not against `sent`: after a 400 the empty
    // `sent` must stay empty until the merge itself changes.
    if (sameList(fused, lastFused)) return
    lastFused = fused
    emptyUntilChange = false
    sent = fused
    if (link.kind === 'Idle') ensureOpen()
    else if (link.kind === 'Ready') maybeSendPut()
  }

  function onSessionTokenInner(token: string | null): void {
    const binding = bindingOf(token)
    const old = session
    const generation =
      token !== (old?.token ?? null) ? (old?.generation ?? 0) + 1 : (old?.generation ?? 0)
    session = { token, generation, binding }
    if (latch && generation > latch.generation) latch = null
    if (unsupportedGeneration !== null && generation > unsupportedGeneration)
      unsupportedGeneration = null
    if (token === null) {
      clearOwnerLists()
      resetSessionState()
      closeLink('logout', 'reopen')
    }
    // A null binding is different from everything, so an undecodable token
    // also drops every list: none of them can be attributed to its user.
    if (!old?.binding || !binding || old.binding.userId !== binding.userId) {
      clearOwnerLists()
      resetSessionState()
    }
    if (link.kind !== 'Idle' && bindingChanged(old?.binding, binding))
      closeLink('binding', 'reopen')
    ensureOpen()
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  const client = {
    /** The committed session token changed (login, refresh, team switch, hop restore, logout). Never throws. */
    onSessionToken(token: string | null): void {
      guarded('sessionToken', undefined, () => onSessionTokenInner(token))
    },

    /**
     * A transient team hop started. The depth is read live from the app
     * service, and a hop does not block openings, so there is no transition.
     */
    onHopEnter(): void {},

    /** Called inside the idempotent release of a hop, once per hop. */
    onHopRelease(currentAppToken: string | null): void {
      guarded('hopRelease', undefined, () => {
        if (hopDepth() === 0) {
          // A hop without restore commits its token without publishing it; this
          // publishes it, so an expiry of the original token finds a newer session.
          if (currentAppToken !== (session?.token ?? null)) onSessionTokenInner(currentAppToken)
          if (latch?.deferred && !hasNewerCommittedSession(latch.generation)) {
            latch.deferred = false
            emitSessionExpired()
          }
        }
        ensureOpen()
      })
    },

    onEnvSwitchStart(): void {
      guarded('envStart', undefined, () => {
        envSwitching = true
        closeLink('env', 'reopen')
      })
    },

    /** Runs whether or not the environment changed. */
    onEnvSwitchEnd(changed: boolean): void {
      guarded('envEnd', undefined, () => {
        envSwitching = false
        if (changed) {
          // A token of the previous environment must never open a stream on
          // the new one, even if no logout was published before this.
          onSessionTokenInner(null)
          clearOwnerLists()
          resetSessionState()
        }
        ensureOpen()
      })
    },

    /**
     * `stopAllStreams`. Its producers always publish the token in the same
     * tick first, and that already decided whether the binding changed; with a
     * session there is nothing left to do.
     */
    onStopAllStreams(): void {
      guarded('stopAllStreams', undefined, () => {
        if (session?.token) return
        if (link.kind !== 'Idle') closeLink('stop', 'reopen')
      })
    },

    /**
     * The renderer's priority-ordered key list. `senderFrameToken` is the IPC's
     * `senderFrame.frameToken`; a list from another document or a subframe is
     * dropped, and a list derived for another user counts as empty. The answer
     * tells a newly mounted renderer that the session already expired.
     */
    setSubscriptions(
      owner: GfsWatchOwner,
      payload: { keys?: unknown; userId?: unknown } | null | undefined,
      senderFrameToken: string | null
    ): { sessionExpired: boolean } {
      return guarded('setSubscriptions', { sessionExpired: false }, () => {
        if (owner.isDestroyed() || senderFrameToken === null) return { sessionExpired: false }
        let rec = owners.get(owner.id)
        if (!rec) {
          rec = {
            handle: owner,
            frameToken: owner.mainFrameToken(),
            regOrder: ++regCounter,
            keys: [],
          }
          owners.set(owner.id, rec)
        }
        rec.handle = owner
        if (senderFrameToken !== rec.frameToken) return { sessionExpired: false }
        const forCurrentUser =
          session?.binding != null && normUid(payload?.userId) === session.binding.userId
        rec.keys = forCurrentUser ? withinSetCeilings(canonList(payload?.keys)) : []
        recompute()
        return { sessionExpired: latch !== null && !latch.deferred }
      })
    },

    /** `gfsWatch:stop` from the renderer: only empties its list; the document may subscribe again. */
    stopOwner(owner: GfsWatchOwner, senderFrameToken: string | null): void {
      guarded('stopOwner', undefined, () => {
        const rec = owners.get(owner.id)
        if (!rec || senderFrameToken === null || senderFrameToken !== rec.frameToken) return
        rec.keys = []
        recompute()
      })
    },

    /** `did-navigate`: a new document in the same owner; its lists come when it mounts. */
    ownerNavigated(ownerId: number, frameToken: string | null): void {
      guarded('ownerNavigated', undefined, () => {
        const rec = owners.get(ownerId)
        if (!rec) return
        rec.keys = []
        rec.frameToken = frameToken
        recompute()
      })
    },

    /** `render-process-gone`: Electron cannot read the frame token here, so IPC waits for the next navigation. */
    ownerProcessGone(ownerId: number): void {
      guarded('ownerProcessGone', undefined, () => {
        const rec = owners.get(ownerId)
        if (!rec) return
        rec.keys = []
        rec.frameToken = null
        recompute()
      })
    },

    /** `destroyed`. The stream stays open with no owners: it is still the session channel. */
    ownerDestroyed(ownerId: number): void {
      guarded('ownerDestroyed', undefined, () => {
        if (!owners.delete(ownerId)) return
        recompute()
      })
    },

    hasOwner(ownerId: number): boolean {
      return owners.has(ownerId)
    },

    /** Stops every request and timer for good (process shutdown). */
    dispose(): void {
      guarded('dispose', undefined, () => {
        closeLink('dispose', 'halt')
        disposed = true
      })
    },

    inspect(): GfsWatchInspection {
      return {
        link,
        put,
        sent,
        desired,
        emptyUntilChange,
        poisonedPut,
        session,
        envSwitching,
        latch,
        unsupportedGeneration,
        epoch,
        openAttempt,
        degraded: degraded !== null,
        refreshAccessOnReady,
        putAttempt,
        deferredTimer,
        deferredAttempt,
        seq,
        owners: new Map(
          [...owners].map(([id, o]) => [
            id,
            { frameToken: o.frameToken, regOrder: o.regOrder, keys: o.keys },
          ])
        ),
      }
    },
  }
  bestEffort(() => fallback.onClientCreated?.(client))
  return client
}
