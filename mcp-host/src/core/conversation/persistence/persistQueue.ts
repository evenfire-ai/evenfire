/** Main-thread transport with ordered writes and acknowledged, bounded shutdown. */
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
  onHeartbeat?: (payload: HeartbeatPayload) => void
  onTransportError?: (err: Error) => void
  onExit?: (code: number) => void
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
  private readonly accepted = new Set<Promise<unknown>>()
  private closed = false
  private closing = false
  private exited = false
  private failure: Error | undefined
  private asyncWriteFailure: Error | undefined
  private closePromise: Promise<void> | undefined
  private readonly exitPromise: Promise<void>

  constructor(
    private readonly worker: WorkerLike,
    private readonly opts: PersistQueueOptions
  ) {
    let resolveExit!: () => void
    this.exitPromise = new Promise<void>(resolve => {
      resolveExit = resolve
    })
    this.worker.on('message', reply => this.handleReply(reply))
    this.worker.on('error', err => this.failTransport(err))
    this.worker.on('exit', code => {
      this.exited = true
      this.closed = true
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeoutHandle)
        entry.reject(
          new Error(`db worker exited (code=${code}) while op=${entry.op.kind} was pending`)
        )
      }
      this.pending.clear()
      if (code !== 0) this.failure ??= new Error('ConversationStoreWorkerExited')
      resolveExit()
      this.opts.onExit?.(code)
    })
  }

  enqueueAsync(sessionKey: string, op: WorkerOp): void {
    this.assertAdmissionOpen()
    const previous = this.writeChain.get(sessionKey) ?? Promise.resolve()
    const write = previous.then(() => this.send(op, this.opts.asyncTimeoutMs))
    const next = write
      .then(() => undefined)
      .catch(error => {
        this.asyncWriteFailure ??=
          error instanceof Error ? error : new Error('ConversationStoreWriteFailed')
        logger.error(
          { err: error, operation: op.kind },
          '[PersistQueue] accepted async write failed'
        )
      })
      .finally(() => {
        if (this.writeChain.get(sessionKey) === next) this.writeChain.delete(sessionKey)
      })
    this.track(next)
    this.writeChain.set(sessionKey, next)
  }

  enqueueSync<T = unknown>(op: WorkerOp, sessionKey?: string): Promise<T> {
    try {
      this.assertAdmissionOpen()
    } catch (error) {
      return Promise.reject(error)
    }
    if (!sessionKey) return this.track(this.send<T>(op, this.opts.syncTimeoutMs))
    const previous = this.writeChain.get(sessionKey) ?? Promise.resolve()
    const next = this.track(previous.then(() => this.send<T>(op, this.opts.syncTimeoutMs)))
    const ordered = next
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.writeChain.get(sessionKey) === ordered) this.writeChain.delete(sessionKey)
      })
    this.writeChain.set(sessionKey, ordered)
    return next
  }

  async drainSessionKey(sessionKey: string): Promise<void> {
    await this.writeChain.get(sessionKey)
    if (this.asyncWriteFailure) throw this.asyncWriteFailure
  }

  async drainPrefix(prefix: string): Promise<void> {
    await Promise.all(
      Array.from(this.writeChain)
        .filter(([key]) => key.startsWith(prefix))
        .map(([, chain]) => chain)
    )
    if (this.asyncWriteFailure) throw this.asyncWriteFailure
  }

  /** Includes unkeyed synchronous calls and operations still waiting in ordering chains. */
  async drain(): Promise<void> {
    while (this.accepted.size) await Promise.allSettled(Array.from(this.accepted))
    if (this.failure) throw this.failure
    // A logged async failure cannot become a successful maintenance/drained receipt.
    if (this.asyncWriteFailure) throw this.asyncWriteFailure
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.finishClose()
    return this.closePromise
  }

  private async finishClose(): Promise<void> {
    let drainError: unknown
    try {
      await this.drain()
    } catch (error) {
      drainError = error
    }
    try {
      if (this.failure) throw this.failure
      if (!this.closed) await this.send({ kind: 'shutdown' }, this.opts.syncTimeoutMs)
      await this.waitForExit()
    } catch (error) {
      // A forced termination is containment, never a successful drain proof.
      try {
        if (!this.exited) await this.worker.terminate()
      } catch (err) {
        logger.warn({ err }, '[PersistQueue] worker termination failed')
      }
      this.closed = true
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timeoutHandle)
        entry.reject(new Error('PersistQueue closed without a durable acknowledgment'))
      }
      this.pending.clear()
      throw error
    }
    if (drainError) throw drainError
  }

  private async waitForExit(): Promise<void> {
    if (this.exited) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.exitPromise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('ConversationStoreShutdownTimeout')),
            this.opts.syncTimeoutMs
          )
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (this.failure) throw this.failure
  }

  private assertAdmissionOpen(): void {
    if (this.closed || this.closing) throw new Error('PersistQueue is closed')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.accepted.add(operation)
    void operation.then(
      () => this.accepted.delete(operation),
      () => this.accepted.delete(operation)
    )
    return operation
  }

  private send<T>(op: WorkerOp, timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('PersistQueue is closed'))
    const id = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.pending.delete(id))
          reject(new Error(`db worker timeout (${timeoutMs}ms) for op=${op.kind}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as PendingEntry['resolve'],
        reject,
        timeoutHandle,
        op,
      })
      try {
        this.worker.postMessage({ id, op })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timeoutHandle)
        reject(error)
      }
    })
  }

  private failTransport(error: Error): void {
    this.failure ??= error
    this.closed = true
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutHandle)
      entry.reject(error)
    }
    this.pending.clear()
    this.opts.onTransportError?.(error)
  }

  private handleReply(reply: WorkerReply): void {
    if (reply.id === '__fatal__') {
      const error = new Error(reply.error?.message ?? 'ConversationStoreWorkerFatal')
      ;(error as Error & { code?: string }).code = reply.error?.code
      this.failTransport(error)
      return
    }
    if (reply.id === HEARTBEAT_ID) {
      this.opts.onHeartbeat?.(reply.result as HeartbeatPayload)
      return
    }
    const entry = this.pending.get(reply.id)
    if (!entry) return
    clearTimeout(entry.timeoutHandle)
    this.pending.delete(reply.id)
    if (reply.ok) entry.resolve(reply.result)
    else {
      const error = new Error(reply.error?.message ?? 'unknown worker error')
      ;(error as Error & { code?: string }).code = reply.error?.code
      entry.reject(error)
    }
  }
}
