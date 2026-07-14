/**
 * Test scaffolding for the SQLite ConversationStore tests.
 *
 * The real worker thread is overkill for unit tests; we instead provide:
 *   - `createInProcessWorker(dbPath?)` — drives a Database directly from
 *     the main thread, posting replies back synchronously. Behaves like a
 *     `WorkerLike` for `PersistQueue`.
 *   - `makeSqliteStore(opts)` — builds an `SqliteConversationStore` over
 *     the in-process worker and returns a handle with the underlying db
 *     for assertions.
 */
import Database from 'better-sqlite3'
import { EventEmitter } from 'node:events'
import { runMigrations } from '../../../../db/migrate'
import { applyPragmas } from '../../../../db/pragmas'
import { createDispatcher, dispatch } from '../../../../db/worker/dispatcher'
import type { WorkerMessage, WorkerReply } from '../../../../db/worker/protocol'
import { PersistQueue, type WorkerLike } from '../persistQueue'
import { SqliteConversationStore } from '../sqliteConversationStore'

export interface InProcessWorkerHandle {
  worker: WorkerLike
  db: Database.Database
  terminate: () => void
  /** Simulate the worker dying. Subsequent posts reject. */
  crash: (code?: number) => void
}

export function createInProcessWorker(dbPath: string = ':memory:'): InProcessWorkerHandle {
  const ee = new EventEmitter()
  ee.setMaxListeners(50)
  const db = new Database(dbPath)
  applyPragmas(db)
  runMigrations(db)
  const deps = createDispatcher(db)
  let alive = true

  function on(event: 'message', listener: (reply: WorkerReply) => void): void
  function on(event: 'error', listener: (err: Error) => void): void
  function on(event: 'exit', listener: (code: number) => void): void
  function on(event: string, listener: (...args: never[]) => void): void {
    ee.on(event, listener as (...args: unknown[]) => void)
  }

  const worker: WorkerLike = {
    postMessage(msg: WorkerMessage) {
      if (!alive) {
        queueMicrotask(() => {
          ee.emit('message', {
            id: msg.id,
            ok: false,
            error: { code: 'WORKER_DEAD', message: 'worker terminated' },
          } satisfies WorkerReply)
        })
        return
      }
      queueMicrotask(async () => {
        try {
          const result = await dispatch(msg.op, deps)
          if (msg.op.kind === 'shutdown') {
            alive = false
            ee.emit('message', { id: msg.id, ok: true, result } satisfies WorkerReply)
            ee.emit('exit', 0)
            return
          }
          ee.emit('message', { id: msg.id, ok: true, result } satisfies WorkerReply)
        } catch (err) {
          const e = err as { code?: string; message?: string }
          ee.emit('message', {
            id: msg.id,
            ok: false,
            error: { code: e.code ?? 'WORKER_ERROR', message: e.message ?? String(err) },
          } satisfies WorkerReply)
        }
      })
    },
    on,
    terminate() {
      alive = false
      try {
        db.close()
      } catch {
        /* ignore */
      }
      ee.emit('exit', 0)
    },
  }

  return {
    worker,
    db,
    terminate: () => worker.terminate(),
    crash: (code = 1) => {
      alive = false
      try {
        db.close()
      } catch {
        /* ignore */
      }
      ee.emit('exit', code)
    },
  }
}

export interface StoreHandle {
  store: SqliteConversationStore
  persistQueue: PersistQueue
  worker: InProcessWorkerHandle
  shutdown: () => Promise<void>
}

export function makeSqliteStore(opts: { dbPath?: string; cacheSize?: number } = {}): StoreHandle {
  const worker = createInProcessWorker(opts.dbPath ?? ':memory:')
  const persistQueue = new PersistQueue(worker.worker, {
    syncTimeoutMs: 2000,
    asyncTimeoutMs: 5000,
  })
  const store = new SqliteConversationStore(persistQueue, {
    cacheSize: opts.cacheSize ?? 8,
  })
  return {
    store,
    persistQueue,
    worker,
    async shutdown() {
      await persistQueue.close()
    },
  }
}
