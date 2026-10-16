/**
 * `PersistQueue` — main-thread façade in front of the SQLite worker thread.
 *
 * - `enqueueSync(op)` resolves when the worker ACKs (or rejects on error /
 *   timeout). Used for IronClaw-critical writes: suspendForApproval, approve,
 *   deny, completeTurn with billed usage.
 * - `enqueueAsync(sessionKey, op)` does not wait for the ACK but preserves the
 *   `sessionKey`-scoped ordering chain (per `SessionProcessor`'s FIFO
 *   invariant). An async write stays pending until the worker answers or
 *   exits; a slow ACK is only logged, so its outcome is never guessed. A
 *   failed async write marks the queue failed: every later write rejects
 *   with that failure and `onFailure` fires once, so the Host stops instead
 *   of accepting writes it can no longer persist. The same holds after an
 *   unexpected worker exit.
 * - Progress bound: once the database is open, or once `close()` has started,
 *   while the worker has operations in flight it must complete one within
 *   `stallTimeoutMs` of the previous completion (or of the moment work became
 *   in flight, or of the start of `close()` before open). A slow
 *   worker keeps completing operations, however long its backlog; a wedged
 *   one stops, and the queue fails the same way as after a worker exit. The
 *   bound measures worker progress, never how long a write has waited.
 *
 * The implementation is transport-agnostic: callers inject a `WorkerLike`
 * (typically a `node:worker_threads.Worker`, but tests inject an in-process
 * dispatcher). This keeps the unit-test surface tractable without spinning
 * up real worker threads.
 */
import { randomUUID } from 'node:crypto'
import type {
  HeartbeatPayload,
  WorkerMessage,
  WorkerOp,
  WorkerReply,
} from '../../../db/worker/protocol'
import { HEARTBEAT_ID } from '../../../db/worker/protocol'
import { logger } from '../../../logger'

export interface WorkerLike {
  postMessage(msg: WorkerMessage): void
  on(event: 'message', listener: (reply: WorkerReply) => void): void
  on(event: 'error', listener: (err: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  terminate(): Promise<number> | void
}

export interface PersistQueueOptions {
  syncTimeoutMs: number
  /** An async write not ACKed within this time is logged and kept pending. */
  asyncTimeoutMs: number
  /**
   * Longest time the worker may go without completing an operation while it
   * has operations in flight, in service and during `close()`. In service it
   * applies only once the `awaitOpen()` ping is answered; once `close()` has
   * started it applies even if the database never opened, counted from the
   * start of `close()`.
   */
  stallTimeoutMs: number
  /** Called whenever a heartbeat reply is observed (id === HEARTBEAT_ID). */
  onHeartbeat?: (payload: HeartbeatPayload) => void
  /** Called on transport-level errors (worker crashed, message channel broke). */
  onTransportError?: (err: Error) => void
  /**
   * Called with the exit code when the worker exits before ACKing `shutdown`,
   * for logging. The same exit is reported through `onFailure`, which ends
   * the process. The exit that follows a `shutdown` ACK is not reported.
   */
  onExit?: (code: number) => void
  /**
   * Called once, with the first failure that makes the queue unusable: an
   * async write failed, the worker made no progress within `stallTimeoutMs`,
   * or the worker exited before ACKing `shutdown`.
   */
  onFailure?: (err: Error) => void
}

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  /** Absent for `awaitOpen`, which has no timeout. */
  timeoutHandle?: ReturnType<typeof setTimeout>
  op: WorkerOp
}

export class PersistQueue {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly writeChain = new Map<string, Promise<void>>()
  /** Set once admission closes (graceful `close()` or worker exit). */
  private closed = false
  private exited = false
  /** The worker ACKed `shutdown`; its exit that follows is expected. */
  private shutdownAcked = false
  /** First failure that makes further writes unsafe; never cleared. */
  private failure: Error | null = null
  private closePromise: Promise<void> | null = null
  /**
   * Ids posted to the worker and not yet answered. Unlike `pending`, an id
   * stays here after its caller's timeout: the worker is still busy with it.
   */
  private readonly inFlight = new Set<string>()
  private inFlightWaiters: Array<() => void> = []
  /** The `awaitOpen()` ping was answered; the progress bound applies. */
  private opened = false
  /** `performance.now()` of the last completion, or of in-flight going 0 → 1. */
  private lastProgressAt = 0
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  /** The progress bound expired and the worker was terminated. */
  private stalled = false

  constructor(
    private readonly worker: WorkerLike,
    private readonly opts: PersistQueueOptions
  ) {
    this.worker.on('message', reply => this.handleReply(reply))
    this.worker.on('error', err => {
      if (this.opts.onTransportError) this.opts.onTransportError(err)
    })
    this.worker.on('exit', code => {
      this.closed = true
      this.exited = true
      // Flush pending with an explicit error so callers don't hang.
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeoutHandle)
        entry.reject(
          new Error(`db worker exited (code=${code}) while op=${entry.op.kind} was pending`)
        )
      }
      this.pending.clear()
      this.settleInFlight()
      if (this.shutdownAcked) return
      if (this.opts.onExit) this.opts.onExit(code)
      this.recordFailure(new Error(`db worker exited (code=${code})`))
    })
  }

  /**
   * Write without waiting for the ACK. Ordering is preserved per `sessionKey`
   * so a `startTurn` precedes its `completeTurn` on disk regardless of
   * scheduling jitter. Throws when the queue is closed or an earlier write
   * failed; a failure of this write is recorded and surfaces on the next
   * write, through `onFailure` and from `close()`.
   */
  enqueueAsync(sessionKey: string, op: WorkerOp): void {
    this.assertAdmissible()
    const prev = this.writeChain.get(sessionKey) ?? Promise.resolve()
    const next = prev
      .then(() => this.sendUnlessFailed(op, this.opts.asyncTimeoutMs, 'warn'))
      .then(() => {
        /* discard the result — async path */
      })
      .catch((err: Error) => {
        // An earlier failure already recorded and logged.
        if (err === this.failure) return
        const failure = new Error(
          `async write failed (sessionKey=${sessionKey}): ${err.message ?? String(err)}`
        )
        logger.error({ sessionKey, err }, '[PersistQueue] async write failed')
        this.recordFailure(failure)
      })
      .finally(() => {
        // Drop the chain reference once it settles so we don't keep arbitrarily
        // long histories per session.
        if (this.writeChain.get(sessionKey) === next) {
          this.writeChain.delete(sessionKey)
        }
      })
    this.writeChain.set(sessionKey, next)
  }

  /**
   * Sync write. Resolves with the worker's `result` field. Rejects on:
   * - worker-reported error (`reply.ok === false`)
   * - timeout (`syncTimeoutMs` elapsed)
   * - transport disconnect (worker exit)
   *
   * When `sessionKey` is provided, the sync write happens AFTER all
   * preceding async writes for that key. This preserves the durable
   * write order — e.g. `persistTurnStart` (async) lands in SQLite before
   * `persistSuspend` (sync). Without the chain the sync write could
   * race the async one and the snapshot reads inconsistent state.
   */
  enqueueSync<T = unknown>(op: WorkerOp, sessionKey?: string): Promise<T> {
    try {
      this.assertAdmissible()
    } catch (err) {
      return Promise.reject(err as Error)
    }
    if (sessionKey) {
      const prev = this.writeChain.get(sessionKey) ?? Promise.resolve()
      const next = prev.then(() => this.sendUnlessFailed<T>(op, this.opts.syncTimeoutMs))
      // The chain derivative must never surface the rejection itself — the
      // caller gets it via the returned `next` (loud there). Without the
      // rejection handler a failed sync write would ALSO raise a process-level
      // unhandledRejection from this internal bookkeeping copy (D3). The
      // cleanup compares against the derivative, because that is what the map
      // holds.
      const chained: Promise<void> = next
        .then(
          () => undefined,
          () => undefined
        )
        .finally(() => {
          if (this.writeChain.get(sessionKey) === chained) {
            this.writeChain.delete(sessionKey)
          }
        })
      this.writeChain.set(sessionKey, chained)
      return next
    }
    return this.send<T>(op, this.opts.syncTimeoutMs)
  }

  /**
   * Resolves when the worker answers a `ping`. The worker registers its
   * message handler only after it has opened and migrated the database, so
   * this resolves once the database is open. No timeout: opening (spawn,
   * migrations, recovery of a large WAL) can outlast any write budget, so
   * the progress bound applies only once this ping is answered, or once
   * `close()` has started.
   * Rejects on a worker error reply, a worker exit, or when the worker makes
   * no progress within `stallTimeoutMs` after `close()` started; a `close()`
   * that finds the ping answered in time lets it resolve.
   */
  awaitOpen(): Promise<void> {
    try {
      this.assertAdmissible()
    } catch (err) {
      return Promise.reject(err as Error)
    }
    return this.send<unknown>({ kind: 'ping' }, null).then(() => {
      this.opened = true
      this.lastProgressAt = performance.now()
      this.armStallTimer()
    })
  }

  /**
   * Wait until every pending async write for `sessionKey` settles. Used by
   * `SqliteConversationStore` before sync write-through operations that
   * read other rows (e.g. load_active_session after persistTurnStart).
   */
  async drainSessionKey(sessionKey: string): Promise<void> {
    const chain = this.writeChain.get(sessionKey)
    if (!chain) return
    try {
      await chain
    } catch {
      /* errors are reported by the chained .catch in enqueueAsync */
    }
  }

  /**
   * Wait until every pending async write whose `sessionKey` STARTS WITH
   * `prefix` settles. The prefix analogue of `drainSessionKey`: used by
   * `SqliteConversationStore.prefetchUserSessions` before its bulk
   * `list_sessions_by_prefix` read, so a just-completed session still in the
   * per-key write chain isn't reconstructed from stale rows (sqlite-stores-3).
   */
  async drainPrefix(prefix: string): Promise<void> {
    const chains: Array<Promise<void>> = []
    for (const [key, chain] of this.writeChain) {
      if (key.startsWith(prefix)) chains.push(chain)
    }
    if (chains.length === 0) return
    await Promise.allSettled(chains)
  }

  /**
   * Wait for the keyed async chains, not for in-flight sync operations. Used
   * by the stateless suspend checkpoint (`main.ts`, `flushFinalCheckpoint`).
   * `close()` does its own stricter wait.
   */
  async drain(): Promise<void> {
    const chains = Array.from(this.writeChain.values())
    if (chains.length === 0) return
    await Promise.allSettled(chains)
  }

  /**
   * Graceful shutdown: close admission, wait until every accepted write has
   * settled (the keyed chains and every operation in flight, sync writes
   * without a `sessionKey` included), wait for the worker to ACK `shutdown`
   * (it closes the database before replying), then terminate it. There is no
   * total deadline: a slow worker drains its whole backlog, and only the
   * progress bound (`stallTimeoutMs`) ends the wait for a wedged one. If the
   * database has not opened yet, the bound starts with this call, so a worker
   * that never answers the open ping fails within `stallTimeoutMs` while a
   * slow but healthy open can still finish.
   * Rejects with the first failure, so the caller sees that the durable
   * trail is incomplete.
   */
  close(): Promise<void> {
    // A second caller waits for the same shutdown instead of returning early.
    this.closePromise ??= this.shutdown()
    return this.closePromise
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    if (!this.opened) {
      // The open ping may still be in flight; the bound starts now, not when
      // the ping was posted, so a slow but healthy open can still finish.
      this.lastProgressAt = performance.now()
      this.armStallTimer()
    }
    // Admission is closed, so no chain starts after this snapshot.
    await Promise.allSettled(Array.from(this.writeChain.values()))
    await this.inFlightSettled()
    if (!this.exited && !this.stalled) {
      try {
        // Checkpointing on close can outlast `syncTimeoutMs`; the progress
        // bound covers this operation like any other.
        await this.send({ kind: 'shutdown' }, null)
      } catch (err) {
        // Recorded before terminate(), so the exit it causes is not reported
        // as a second failure.
        this.recordFailure(err as Error)
      }
    }
    if (!this.stalled) {
      // A stalled worker was already terminated by checkStall().
      const terminated = this.worker.terminate()
      if (terminated && typeof (terminated as Promise<number>).then === 'function') {
        await terminated
      }
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutHandle)
      entry.reject(new Error('PersistQueue closed'))
    }
    this.pending.clear()
    if (this.failure) throw this.failure
  }

  private inFlightSettled(): Promise<void> {
    if (this.inFlight.size === 0) return Promise.resolve()
    return new Promise(resolve => this.inFlightWaiters.push(resolve))
  }

  /** Forget every in-flight id (worker gone or stalled) and wake waiters. */
  private settleInFlight(): void {
    this.inFlight.clear()
    clearTimeout(this.stallTimer)
    this.stallTimer = undefined
    this.notifyInFlightSettled()
  }

  private notifyInFlightSettled(): void {
    if (this.inFlight.size !== 0) return
    const waiters = this.inFlightWaiters
    this.inFlightWaiters = []
    for (const resolve of waiters) resolve()
  }

  private armStallTimer(): void {
    // Still armed after another failure: close() waits for in-flight work.
    // Before open the bound applies only once close() has started.
    if (
      (!this.opened && !this.closed) ||
      this.stalled ||
      this.stallTimer ||
      this.inFlight.size === 0
    ) {
      return
    }
    const remaining = this.opts.stallTimeoutMs - (performance.now() - this.lastProgressAt)
    this.stallTimer = setTimeout(
      () => {
        this.stallTimer = undefined
        // Timers run before the poll phase that delivers worker replies. After
        // a main-thread stall an answer can be waiting; read it first.
        setImmediate(() => this.checkStall())
      },
      Math.max(0, remaining)
    )
  }

  private checkStall(): void {
    if (this.stalled || this.inFlight.size === 0) return
    if (performance.now() - this.lastProgressAt < this.opts.stallTimeoutMs) {
      this.armStallTimer()
      return
    }
    const count = this.inFlight.size
    this.stalled = true
    const failure = new Error(
      `db worker made no progress for ${this.opts.stallTimeoutMs}ms with ${count} operation(s) in flight`
    )
    // The logger keeps only an error's name, so the cause is logged as fields.
    logger.error(
      { stallTimeoutMs: this.opts.stallTimeoutMs, inFlight: count },
      '[PersistQueue] db worker made no progress; terminating it'
    )
    this.recordFailure(failure)
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutHandle)
      entry.reject(failure)
    }
    this.pending.clear()
    this.settleInFlight()
    // The failure is recorded first, so the exit that follows is not reported
    // as a second one. Not awaited: a wedged thread may take a while to stop.
    const terminated = this.worker.terminate()
    if (terminated && typeof (terminated as Promise<number>).then === 'function') {
      ;(terminated as Promise<number>).catch((err: unknown) => {
        logger.warn({ err }, '[PersistQueue] terminating the stalled db worker failed')
      })
    }
  }

  private recordFailure(err: Error): void {
    if (this.failure) return
    this.failure = err
    if (this.opts.onFailure) this.opts.onFailure(err)
  }

  private assertAdmissible(): void {
    if (this.failure) throw this.failure
    if (this.closed) throw new Error('PersistQueue is closed')
  }

  /**
   * Post a write that waited on its `sessionKey` chain. The queue may have
   * failed while it waited, and admission was checked before that.
   */
  private sendUnlessFailed<T>(
    op: WorkerOp,
    timeoutMs: number,
    onTimeout: 'reject' | 'warn' = 'reject'
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    return this.send<T>(op, timeoutMs, onTimeout)
  }

  /**
   * `onTimeout: 'warn'` logs once when `timeoutMs` elapses and keeps waiting
   * for the ACK or the worker exit.
   */
  private send<T>(
    op: WorkerOp,
    timeoutMs: number | null,
    onTimeout: 'reject' | 'warn' = 'reject'
  ): Promise<T> {
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              if (onTimeout === 'warn') {
                if (this.pending.has(id)) {
                  logger.warn(
                    { op: op.kind, timeoutMs },
                    '[PersistQueue] async write not acknowledged yet; still waiting'
                  )
                }
              } else if (this.pending.delete(id)) {
                reject(new Error(`db worker timeout (${timeoutMs}ms) for op=${op.kind}`))
              }
            }, timeoutMs)
      const entry: PendingEntry = {
        resolve: resolve as PendingEntry['resolve'],
        reject,
        timeoutHandle,
        op,
      }
      this.pending.set(id, entry)
      try {
        this.worker.postMessage({ id, op })
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timeoutHandle)
        reject(err as Error)
        return
      }
      if (this.inFlight.size === 0) this.lastProgressAt = performance.now()
      this.inFlight.add(id)
      this.armStallTimer()
    })
  }

  private handleReply(reply: WorkerReply): void {
    if (reply.id === HEARTBEAT_ID) {
      if (this.opts.onHeartbeat) {
        this.opts.onHeartbeat(reply.result as HeartbeatPayload)
      }
      return
    }
    if (this.inFlight.delete(reply.id)) {
      this.lastProgressAt = performance.now()
      clearTimeout(this.stallTimer)
      this.stallTimer = undefined
      this.armStallTimer()
      this.notifyInFlightSettled()
    }
    const entry = this.pending.get(reply.id)
    if (!entry) return
    clearTimeout(entry.timeoutHandle)
    this.pending.delete(reply.id)
    if (reply.ok) {
      // Set synchronously: the worker's exit can be delivered before the
      // awaiting `close()` resumes.
      if (entry.op.kind === 'shutdown') this.shutdownAcked = true
      entry.resolve(reply.result)
    } else {
      const err = new Error(reply.error?.message ?? 'unknown worker error')
      ;(err as Error & { code?: string }).code = reply.error?.code
      entry.reject(err)
    }
  }
}
