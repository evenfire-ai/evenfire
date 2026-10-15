/**
 * `PersistQueue` — main-thread façade in front of the SQLite worker thread.
 *
 * - `enqueueSync(op)` resolves when the worker ACKs (or rejects on error /
 *   timeout). Used for IronClaw-critical writes: suspendForApproval, approve,
 *   deny, completeTurn with billed usage.
 * - `enqueueAsync(sessionKey, op)` does not wait for the ACK but preserves the
 *   `sessionKey`-scoped ordering chain (per `SessionProcessor`'s FIFO
 *   invariant). A failed async write marks the queue failed: every later
 *   write rejects with that failure and `onFailure` fires once, so the Host
 *   stops instead of accepting writes it can no longer persist. The same
 *   holds after an unexpected worker exit.
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
  asyncTimeoutMs: number
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
   * async write failed, or the worker exited before ACKing `shutdown`.
   */
  onFailure?: (err: Error) => void
}

interface PendingEntry {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
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
      .then(() => this.sendUnlessFailed(op, this.opts.asyncTimeoutMs))
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
      const next = prev
        .then(() => this.sendUnlessFailed<T>(op, this.opts.syncTimeoutMs))
        .finally(() => {
          if (this.writeChain.get(sessionKey) === (next as Promise<unknown>)) {
            this.writeChain.delete(sessionKey)
          }
        })
      // The chain derivative must never surface the rejection itself — the
      // caller gets it via the returned `next` (loud there). Without the
      // rejection handler a failed sync write would ALSO raise a process-level
      // unhandledRejection from this internal bookkeeping copy (D3).
      this.writeChain.set(
        sessionKey,
        next.then(
          () => undefined,
          () => undefined
        )
      )
      return next
    }
    return this.send<T>(op, this.opts.syncTimeoutMs)
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
   * Wait until every pending async write settles. Intended for graceful
   * shutdown so SIGTERM doesn't truncate the durable trail.
   */
  async drain(): Promise<void> {
    const chains = Array.from(this.writeChain.values())
    if (chains.length === 0) return
    await Promise.allSettled(chains)
  }

  /**
   * Graceful shutdown: close admission, drain every queued write, wait for the
   * worker to ACK `shutdown` (it closes the database before replying), then
   * terminate it. Rejects with the first write failure, or with the shutdown
   * failure, so the caller sees that the durable trail is incomplete.
   */
  close(): Promise<void> {
    // A second caller waits for the same shutdown instead of returning early.
    this.closePromise ??= this.shutdown()
    return this.closePromise
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    await this.drain()
    if (!this.exited) {
      try {
        await this.send({ kind: 'shutdown' }, this.opts.syncTimeoutMs)
      } catch (err) {
        // Recorded before terminate(), so the exit it causes is not reported
        // as a second failure.
        this.recordFailure(err as Error)
      }
    }
    const terminated = this.worker.terminate()
    if (terminated && typeof (terminated as Promise<number>).then === 'function') {
      await terminated
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutHandle)
      entry.reject(new Error('PersistQueue closed'))
    }
    this.pending.clear()
    if (this.failure) throw this.failure
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
  private sendUnlessFailed<T>(op: WorkerOp, timeoutMs: number): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    return this.send<T>(op, timeoutMs)
  }

  private send<T>(op: WorkerOp, timeoutMs: number): Promise<T> {
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pending.delete(id)) {
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
      }
    })
  }

  private handleReply(reply: WorkerReply): void {
    if (reply.id === HEARTBEAT_ID) {
      if (this.opts.onHeartbeat) {
        this.opts.onHeartbeat(reply.result as HeartbeatPayload)
      }
      return
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
